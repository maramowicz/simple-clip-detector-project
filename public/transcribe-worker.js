// Web Worker: lokalna transkrypcja Whisper przez Transformers.js (ONNX Runtime Web).
// Same-origin (plik hostowany u nas) → bez obejść cross-origin. Audio przychodzi jako
// Float32Array 16 kHz mono (transfer bez kopii). Nic nie wychodzi poza przeglądarkę.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

// modele/wagi pobierane z Hugging Face Hub; cache w przeglądarce po pierwszym razie
env.allowLocalModels = false;

// Strona jest cross-origin isolated (COOP/COEP dla ffmpeg core-mt), więc bezpośrednie
// pobieranie z huggingface.co pada na CORS/COEP. Kierujemy pobieranie modeli przez nasz
// Worker (/api/hf/*) — wtedy pliki są SAME-ORIGIN i ładują się bez problemu.
// (Wymaga działającego Workera: wrangler dev lub deploy; goły serve.py tego nie obsłuży.)
env.remoteHost = self.location.origin;
env.remotePathTemplate = 'api/hf/{model}/resolve/{revision}/';

// Mapowanie logicznego rozmiaru na konkretne repo + dtype, per silnik.
//  • WebGPU: onnx-community/* (fp32 enkoder + q4 dekoder — tak jak robi to referencyjny
//    Xenova/whisper-webgpu; fp16 enkoder na WebGPU psuje cechy i powoduje halucynacje).
//  • WASM (CPU): Xenova/* (skwantowane q8) dla małych; turbo tylko z onnx-community (q4).
function resolveModel(size, device){
  const gpu = device === 'webgpu';
  switch(size){
    case 'tiny':  return gpu ? ['onnx-community/whisper-tiny',  {encoder_model:'fp32',decoder_model_merged:'q4'}]
                             : ['Xenova/whisper-tiny', 'q8'];
    case 'small': return gpu ? ['onnx-community/whisper-small', {encoder_model:'fp32',decoder_model_merged:'q4'}]
                             : ['Xenova/whisper-small', 'q8'];
    case 'turbo': return ['onnx-community/whisper-large-v3-turbo',
                          gpu ? {encoder_model:'fp32',decoder_model_merged:'q4'} : 'q4'];
    case 'base':
    default:      return gpu ? ['onnx-community/whisper-base',  {encoder_model:'fp32',decoder_model_merged:'q4'}]
                             : ['Xenova/whisper-base', 'q8'];
  }
}

let current = null; // { key, pipe }

function report(p){
  if(p && (p.status==='progress' || p.status==='download' || p.status==='done')){
    self.postMessage({ type:'progress', stage:'download', file:p.file, progress:p.progress, loaded:p.loaded, total:p.total, status:p.status });
  }
}

async function buildPipe(size, device){
  const [model, dtype] = resolveModel(size, device);
  return pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback: report });
}

async function getPipe(size, device){
  const key = size+'|'+device;
  if(current && current.key===key) return current.pipe;
  if(current && current.pipe && current.pipe.dispose){ try{ await current.pipe.dispose(); }catch(_){} }
  let pipe;
  try{
    pipe = await buildPipe(size, device);
  }catch(err){
    // Fallback: gdy WebGPU nie wstaje (sterownik/pamięć), próbujemy WASM na CPU.
    if(device === 'webgpu'){
      self.postMessage({ type:'progress', file:'WebGPU nieudane — przełączam na WASM (CPU)…' });
      pipe = await buildPipe(size, 'wasm');
      device = 'wasm';
    } else {
      throw err;
    }
  }
  current = { key: size+'|'+device, pipe };
  return pipe;
}

self.onmessage = async (e)=>{
  const m = e.data || {};
  if(m.type !== 'run') return;
  const { id, size, device, language, audio } = m;
  try{
    const pipe = await getPipe(size || 'base', device || 'wasm');
    const out = await pipe(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      language: language || null,   // null → autodetekcja języka
      task: 'transcribe',
      // Dekodowanie greedy — dokładnie jak w referencyjnym Xenova/whisper-webgpu.
      // Halucynacje wynikały z fp16 enkodera (naprawione w resolveModel), nie z
      // dekodowania; dlatego NIE dokładamy tu no_repeat_ngram_size/temperature.
      top_k: 0,
      do_sample: false,
      force_full_sequences: false,
    });
    self.postMessage({ type:'result', id, text: out.text || '', chunks: out.chunks || [] });
  }catch(err){
    self.postMessage({ type:'error', id, message: String(err && err.message || err) });
  }
};
