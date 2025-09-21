/* ...existing code... */
import { set as idbSet, get as idbGet } from "idb-keyval";

const els = {
  pick: document.getElementById("btn-pick-tab"),
  start: document.getElementById("btn-start"),
  stop: document.getElementById("btn-stop"),
  split: document.getElementById("btn-split"),
  grid: document.getElementById("clips-grid"),
  navUrl: document.getElementById("nav-url"),
  navGo: document.getElementById("nav-go"),
  autoSplit: document.getElementById("auto-split-on-nav"),
  navigator: document.getElementById("navigator"),
  composeBtn: document.getElementById("btn-compose"),
  composeStatus: document.getElementById("compose-status"),
  autoSplitCaptured: document.getElementById("auto-split-captured")
};

let captureStream = null;
let recorder = null;
let chunks = [];
let clips = [];
let recording = false;
let currentClipStart = null;
let monitoredUrl = null;
let capMon = { interval: null, videoEl: null, canvas: null, ctx: null };

function fmtTime(ms){
  const s = Math.round(ms/1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
}

async function makeThumb(blob){
  return new Promise((res)=>{
    const v=document.createElement("video");
    v.src=URL.createObjectURL(blob);
    v.muted=true;
    v.addEventListener("loadeddata", ()=>{
      v.currentTime = Math.min(0.25, (v.duration||1)*0.1);
    }, {once:true});
    v.addEventListener("seeked", ()=>{
      const c=document.createElement("canvas");
      c.width=320; c.height=180;
      const ctx=c.getContext("2d");
      ctx.drawImage(v,0,0,c.width,c.height);
      c.toBlob(b=>res(URL.createObjectURL(b)),"image/jpeg",0.7);
      URL.revokeObjectURL(v.src);
    }, {once:true});
  });
}

// get duration of a video blob (ms)
async function getBlobDuration(blob){
  return new Promise((resolve)=>{
    const v=document.createElement("video");
    v.src=URL.createObjectURL(blob);
    v.addEventListener("loadedmetadata", ()=>{
      const ms = (v.duration || 0) * 1000;
      URL.revokeObjectURL(v.src);
      resolve(ms);
    }, {once:true});
  });
}

function renderClips(){
  els.grid.innerHTML = "";
  clips.forEach((c, idx)=>{
    const card = document.createElement("div");
    card.className="clip";
    const img = document.createElement("img");
    img.className="thumb";
    img.src = c.thumb || "";
    const info = document.createElement("div");
    info.className="clip-info";
    const meta = document.createElement("div");
    meta.className="meta";
    meta.textContent = `Clip ${idx+1} • ${fmtTime(c.duration)} • ${new Date(c.createdAt).toLocaleTimeString()}`;
    const sel = document.createElement("label");
    sel.className="sel";
    const cb = document.createElement("input");
    cb.type="checkbox";
    cb.checked = c.selected ?? true;
    cb.addEventListener("change", ()=>{ c.selected = cb.checked; persistClips(); toggleComposeBtn(); });
    const dl = document.createElement("a");
    dl.textContent="Download";
    dl.href = URL.createObjectURL(c.blob);
    dl.download = `clip-${idx+1}.webm`;
    sel.appendChild(cb);
    sel.appendChild(document.createTextNode("Select"));
    info.appendChild(meta);
    info.appendChild(sel);
    card.appendChild(img);
    card.appendChild(info);
    card.appendChild(dl);
    els.grid.appendChild(card);
  });
  toggleComposeBtn();
}

function toggleComposeBtn(){
  els.composeBtn.disabled = !(clips.some(c=>c.selected));
}

async function persistClips(){
  try { await idbSet("auto-clip-clips", clips.map(c=>({ ...c, blob: undefined, blobUrl: URL.createObjectURL(c.blob) }))); } catch {}
}

async function restoreClips(){
  try {
    const saved = await idbGet("auto-clip-clips");
    if (Array.isArray(saved)) {
      clips = await Promise.all(saved.map(async s=>{
        const blob = await fetch(s.blobUrl).then(r=>r.blob());
        return { ...s, blob };
      }));
      renderClips();
    }
  } catch {}
}

function setupRecorder(){
  recorder = new MediaRecorder(captureStream, { mimeType: "video/webm;codecs=vp9,opus" });
  chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size>0) chunks.push(e.data); };
  recorder.onstop = async () => {
    const rawBlob = new Blob(chunks, { type: "video/webm" });
    // auto-append outro to each clip
    const { composeClips } = await import("./composer.js");
    const composedBlob = await composeClips([rawBlob], {
      outroSeconds: 3,
      logoUrl: "/logowhite.png",
      outroAudio: "/hey_hype_radio (2).mp3",
      width: 1280,
      height: 720,
      fps: 30
    });
    const duration = await getBlobDuration(composedBlob);
    const thumb = await makeThumb(composedBlob);
    clips.push({ blob: composedBlob, createdAt: Date.now(), duration, thumb, selected: true });
    renderClips(); persistClips();
    chunks = [];
    if (recording) {
      currentClipStart = Date.now();
      recorder.start(1000);
    }
  };
}

async function pickTab(){
  try{
    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: 30, cursor: "motion" },
      audio: true
    });
    els.start.disabled = false;
    els.split.disabled = true;
    els.stop.disabled = true;
    captureStream.getVideoTracks()[0].addEventListener("ended", ()=>stopAll());
  }catch(e){
    console.error(e);
    alert("Tab picking was canceled or not permitted.");
  }
}

function startRecording(){
  if (!captureStream) { alert("Pick a tab first."); return; }
  if (recording) return;
  setupRecorder();
  recording = true;
  currentClipStart = Date.now();
  recorder.start(1000);
  els.start.disabled = true;
  els.stop.disabled = false;
  els.split.disabled = false;
  if (els.autoSplitCaptured.checked) startCaptureHeuristics();
}

function splitClip(){
  if (recorder && recording) {
    recorder.stop();
  }
}

function stopAll(){
  if (recorder && recording) {
    recording = false;
    recorder.stop();
  }
  if (captureStream) {
    captureStream.getTracks().forEach(t=>t.stop());
    captureStream = null;
  }
  els.start.disabled = !captureStream;
  els.stop.disabled = true;
  els.split.disabled = true;
  stopCaptureHeuristics();
}

function startCaptureHeuristics(){
  if (!captureStream) return;
  const v = document.createElement("video");
  v.srcObject = captureStream; v.muted = true; v.play().catch(()=>{});
  const c = document.createElement("canvas"); c.width = 64; c.height = 36;
  const x = c.getContext("2d"); let lastSig = null; let lastMute = 0;
  const vt = captureStream.getVideoTracks()[0];
  vt.onmute = ()=>{ lastMute = Date.now(); };
  vt.onunmute = ()=>{ if (recording && Date.now()-lastMute<2000) splitClip(); };
  capMon = { interval: setInterval(()=>{
    if (!recording) return;
    try {
      x.drawImage(v,0,0,c.width,c.height);
      const d = x.getImageData(0,0,c.width,c.height).data;
      let sum=0, varsum=0;
      for (let i=0;i<d.length;i+=4){ const g=(d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722); sum+=g; varsum+=g*g; }
      const n=d.length/4, mean=sum/n, std=Math.sqrt(Math.max(0,varsum/n-mean*mean));
      const sig = mean+std*2; // simple signature
      if (lastSig!==null && Math.abs(sig-lastSig)>40) splitClip();
      lastSig = sig;
    } catch {}
  }, 800), videoEl: v, canvas: c, ctx: x };
}

function stopCaptureHeuristics(){
  if (capMon.interval) clearInterval(capMon.interval);
  capMon = { interval: null, videoEl: null, canvas: null, ctx: null };
}

function setupNavigator(){
  const go = ()=>{
    const url = els.navUrl.value.trim();
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    monitoredUrl = href;
    els.navigator.src = href;
  };
  els.navGo.addEventListener("click", go);
  els.navUrl.addEventListener("keydown", (e)=>{ if (e.key==="Enter") go(); });
  els.navigator.addEventListener("load", ()=>{
    if (!els.autoSplit.checked) return;
    if (!recording) return;
    // Auto-split on iframe src change
    splitClip();
  });
}

document.getElementById("btn-compose").addEventListener("click", async ()=>{
  const selected = clips.filter(c=>c.selected);
  if (!selected.length) return;
  els.composeStatus.textContent = "Composing...";
  els.composeStatus.style.color = "";
  els.composeBtn.disabled = true;
  try {
    const { composeClips } = await import("./composer.js");
    const out = await composeClips(selected.map(c=>c.blob), {
      outroSeconds: 3,
      logoUrl: "/logowhite.png",
      outroAudio: "/hey_hype_radio (2).mp3",
      width: 1280,
      height: 720,
      fps: 30
    });
    const url = URL.createObjectURL(out);
    const prev = document.getElementById("final-preview");
    prev.src = url;
    prev.play().catch(()=>{});
    const a = document.getElementById("download-link");
    a.href = url;
    a.style.display = "inline-block";
    els.composeStatus.textContent = "Done.";
  } catch (e){
    console.error(e);
    els.composeStatus.textContent = "Failed.";
    els.composeStatus.style.color = "crimson";
    alert("Composition failed. See console for details.");
  } finally {
    els.composeBtn.disabled = false;
  }
});

els.pick.addEventListener("click", pickTab);
els.start.addEventListener("click", startRecording);
els.split.addEventListener("click", splitClip);
els.stop.addEventListener("click", stopAll);

setupNavigator();
restoreClips();
/* ...existing code... */