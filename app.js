const { PoseLandmarker, FilesetResolver } = window;

const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const placeholder = document.getElementById('placeholder');
let stream = null, landmarker = null, rafId = null, lastVideoTime = -1, running = false;
const $ = id => document.getElementById(id);

const LINKS = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],
  [9,10],[11,12],[11,13],[13,15],[15,17],[15,19],[15,21],
  [12,14],[14,16],[16,18],[16,20],[16,22],[11,23],[12,24],
  [23,24],[23,25],[25,27],[27,29],[29,31],[27,31],[24,26],[26,28],[28,30],[30,32],[28,32]
];

function setStatus(text, on=false) {
  $('cameraStatus').textContent = text;
  $('statusDot').classList.toggle('on', on);
}
function setCheck(id, text, kind='') {
  const el = $(id); el.textContent = text; el.className = kind;
}
function showAdvice(title, text, icon='◎') {
  $('adviceTitle').textContent = title;
  $('adviceText').textContent = text;
  $('adviceIcon').textContent = icon;
}
function resizeCanvas() {
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width*dpr);
  canvas.height = Math.round(rect.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
function drawSkeleton(landmarks, width, height) {
  ctx.clearRect(0,0,width,height);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#9fe0b5';
  ctx.lineCap = 'round';
  for (const [a,b] of LINKS) {
    const p=landmarks[a], q=landmarks[b];
    if (p && q && p.visibility > .35 && q.visibility > .35) {
      ctx.beginPath(); ctx.moveTo(p.x*width,p.y*height); ctx.lineTo(q.x*width,q.y*height); ctx.stroke();
    }
  }
  for (const p of landmarks) {
    if (p && p.visibility > .35) {
      ctx.beginPath(); ctx.arc(p.x*width,p.y*height,4,0,Math.PI*2);
      ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#31745b';ctx.stroke();
    }
  }
}
function angle(a,b,c) {
  const v1={x:a.x-b.x,y:a.y-b.y},v2={x:c.x-b.x,y:c.y-b.y};
  const dot=v1.x*v2.x+v1.y*v2.y;
  const mag=Math.hypot(v1.x,v1.y)*Math.hypot(v2.x,v2.y);
  return Math.acos(Math.max(-1,Math.min(1,dot/(mag||1))))*180/Math.PI;
}
function evaluate(lm) {
  const point = i => lm[i];
  const visible = [11,12,23,24,25,26,27,28].every(i => point(i) && point(i).visibility > .45);
  if (!visible) {
    $('score').textContent='--'; $('scoreBar').style.width='0%';
    $('verdict').textContent='全身を映してください';
    $('scoreCaption').textContent='頭から足先まで、カメラに入る位置に立ってください。';
    showAdvice('全身が見えていません','カメラから少し離れて、肩・腰・両足が画面に入るように調整しましょう。','↔');
    setCheck('torsoCheck','判定不可'); setCheck('balanceCheck','判定不可'); setCheck('bodyCheck','一部検出','warn');
    return;
  }
  const leftHip=point(23), rightHip=point(24), leftShoulder=point(11), rightShoulder=point(12);
  const leftAnkle=point(27), rightAnkle=point(28), leftKnee=point(25), rightKnee=point(26);
  const leftKneeAngle=angle(leftHip,leftKnee,leftAnkle);
  const rightKneeAngle=angle(rightHip,rightKnee,rightAnkle);
  // Approximate tree-pose cue: one knee bends while the other leg remains relatively straight.
  const bentLeft=leftKneeAngle < 150, bentRight=rightKneeAngle < 150;
  const oneLegBent = bentLeft !== bentRight;
  const standingStraight = Math.max(leftKneeAngle,rightKneeAngle) > 155;
  const shoulderMid={x:(leftShoulder.x+rightShoulder.x)/2,y:(leftShoulder.y+rightShoulder.y)/2};
  const hipMid={x:(leftHip.x+rightHip.x)/2,y:(leftHip.y+rightHip.y)/2};
  const torsoTilt=Math.abs(Math.atan2(shoulderMid.x-hipMid.x, hipMid.y-shoulderMid.y)*180/Math.PI);
  const torsoOk=torsoTilt<18;
  let score=45;
  if (oneLegBent) score+=28; else if (bentLeft||bentRight) score+=14;
  if (standingStraight) score+=12;
  if (torsoOk) score+=15;
  score=Math.max(25,Math.min(100,score));
  $('score').textContent=score; $('scoreBar').style.width=score+'%';
  $('verdict').textContent=score>=80?'いい調子！':score>=60?'形を調整しよう':'ポーズを作ってみよう';
  $('scoreCaption').textContent='映像からの簡易推定スコアです。安全性や正確さを保証するものではありません。';
  setCheck('torsoCheck',torsoOk?'安定':'傾きあり',torsoOk?'good':'warn');
  setCheck('balanceCheck',oneLegBent?'片足を曲げている':'形を確認中',oneLegBent?'good':'warn');
  setCheck('bodyCheck','認識中','good');
  if (!oneLegBent) {
    showAdvice('片足を曲げてみよう','木のポーズでは、片足を曲げて足裏を反対側のふくらはぎか太ももに添えます。膝関節を直接押さないでね。','↗');
  } else if (!torsoOk) {
    showAdvice('上半身をまっすぐに','おへそを正面に向け、肩の力を抜いて背筋を長く保ってみましょう。','↕');
  } else {
    showAdvice('いい姿勢！呼吸を続けよう','視線を一点に向けて、ゆっくり呼吸しましょう。ふらつく場合は壁や椅子の近くで行ってください。','✦');
  }
}
async function startCamera() {
  if (running) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showAdvice('この環境ではカメラを起動できません','カメラ利用にはHTTPSまたはlocalhostで開く必要があります。','!');
    setStatus('カメラ利用不可'); return;
  }
  startBtn.disabled=true; startBtn.textContent='準備中…';
  try {
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:1280},height:{ideal:960}},audio:false});
    video.srcObject=stream;
    await new Promise(resolve=>{video.onloadedmetadata=resolve;});
    await video.play();
    setStatus('カメラ起動中',true); placeholder.classList.add('hidden');
    stopBtn.disabled=false; startBtn.textContent='起動中'; running=true;
    $('trackingTag').textContent='● 骨格トラッキング準備中';
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    landmarker = await PoseLandmarker.createFromOptions(vision,{
      baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',delegate:'GPU'},
      runningMode:'VIDEO',numPoses:1
    });
    resizeCanvas();
    $('trackingTag').textContent='● リアルタイム骨格トラッキング中';
    showAdvice('ポーズを始めよう','全身が映ったら、ゆっくり木のポーズを作ってみましょう。','✦');
    loop();
} catch (err) {
  console.error(err);
  stopCamera();

  const errorDetails = `${err?.name || 'Error'}: ${err?.message || '不明なエラー'}`;

  showAdvice(
    '起動できませんでした',
    errorDetails,
    '!'
  );

  setStatus('起動エラー');
  startBtn.disabled = false;
  startBtn.textContent = 'もう一度試す';
}
  }
}
function loop() {
  if (!running || !landmarker) return;
  if (video.readyState>=2 && video.currentTime!==lastVideoTime) {
    lastVideoTime=video.currentTime;
    const result=landmarker.detectForVideo(video,performance.now());
    resizeCanvas();
    const rect=video.getBoundingClientRect();
    if (result.landmarks?.length) {
      drawSkeleton(result.landmarks[0],rect.width,rect.height);
      evaluate(result.landmarks[0]);
    } else {
      ctx.clearRect(0,0,canvas.width,canvas.height);
      $('trackingTag').textContent='● 人物を探しています';
      setCheck('bodyCheck','未検出','warn');
      showAdvice('カメラに全身を映してね','明るい場所で、頭から足先まで映る位置に立ってください。','◎');
    }
  }
  rafId=requestAnimationFrame(loop);
}
function stopCamera() {
  running=false;
  if(rafId) cancelAnimationFrame(rafId);
  rafId=null;
  if(stream) stream.getTracks().forEach(t=>t.stop());
  stream=null; video.srcObject=null;
  if(landmarker){landmarker.close();landmarker=null;}
  ctx.clearRect(0,0,canvas.width,canvas.height);
  placeholder.classList.remove('hidden');
  setStatus('カメラ未起動'); $('trackingTag').textContent='● 骨格トラッキング待機中';
  startBtn.disabled=false;startBtn.textContent='カメラを起動';stopBtn.disabled=true;
  $('score').textContent='--';$('scoreBar').style.width='0%';$('verdict').textContent='カメラを起動してください';
  $('scoreCaption').textContent='全身が映ると、判定が始まります。';
  setCheck('torsoCheck','待機中');setCheck('balanceCheck','待機中');setCheck('bodyCheck','未検出');
}
startBtn.addEventListener('click',startCamera);
stopBtn.addEventListener('click',stopCamera);
window.addEventListener('resize',resizeCanvas);
window.addEventListener('beforeunload',stopCamera);
