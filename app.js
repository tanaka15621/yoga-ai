const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const placeholder = document.getElementById('placeholder');

let stream = null;
let landmarker = null;
let rafId = null;
let lastVideoTime = -1;
let running = false;

const $ = id => document.getElementById(id);

// 骨格リンク定義（MediaPipe Pose）
const LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10], [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [11, 23], [12, 24],
  [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32]
];

function setStatus(text, on = false) {
  $('cameraStatus').textContent = text;
  $('statusDot').classList.toggle('on', on);
}

function setCheck(id, text, kind = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = kind;
}

function showAdvice(title, text, icon = '◎') {
  $('adviceTitle').textContent = title;
  $('adviceText').textContent = text;
  $('adviceIcon').textContent = icon;
}

// キャンバスリサイズ処理の適正化
function resizeCanvas() {
  if (!video.videoWidth || !video.videoHeight) return;
  
  const rect = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  
  const targetWidth = Math.round(rect.width * dpr);
  const targetHeight = Math.round(rect.height * dpr);
  
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
}

// 骨格描画（CSSでscaleX(-1)が当たっている前提）
function drawSkeleton(landmarks, displayWidth, displayHeight) {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);

  // 線の描画
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#9fe0b5';
  ctx.lineCap = 'round';
  
  for (const [a, b] of LINKS) {
    const p = landmarks[a];
    const q = landmarks[b];
    if (p && q && (p.visibility ?? 1) > 0.35 && (q.visibility ?? 1) > 0.35) {
      ctx.beginPath();
      ctx.moveTo(p.x * displayWidth, p.y * displayHeight);
      ctx.lineTo(q.x * displayWidth, q.y * displayHeight);
      ctx.stroke();
    }
  }

  // 関節点の描画
  for (const p of landmarks) {
    if (p && (p.visibility ?? 1) > 0.35) {
      ctx.beginPath();
      ctx.arc(p.x * displayWidth, p.y * displayHeight, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#31745b';
      ctx.stroke();
    }
  }
  ctx.restore();
}

// 3つの関節から角度を計算する関数
function angle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (mag === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
}

// 姿勢の評価ロジック
function evaluate(lm) {
  const point = i => lm[i];
  
  // 主要な主要部位の視認性チェック
  const requiredIndices = [11, 12, 23, 24, 25, 26, 27, 28];
  const visible = requiredIndices.every(i => point(i) && (point(i).visibility ?? 1) > 0.4);

  if (!visible) {
    $('score').textContent = '--';
    $('scoreBar').style.width = '0%';
    $('verdict').textContent = '全身を映してください';
    $('scoreCaption').textContent = '頭から足先まで、カメラに入る位置に立ってください。';
    showAdvice('全身が見えていません', 'カメラから少し離れて、肩・腰・両足が画面に入るように調整しましょう。', '↔');
    setCheck('torsoCheck', '判定不可');
    setCheck('balanceCheck', '判定不可');
    setCheck('bodyCheck', '一部検出', 'warn');
    return;
  }

  const leftShoulder = point(11), rightShoulder = point(12);
  const leftHip = point(23), rightHip = point(24);
  const leftKnee = point(25), rightKnee = point(26);
  const leftAnkle = point(27), rightAnkle = point(28);

  const leftKneeAngle = angle(leftHip, leftKnee, leftAnkle);
  const rightKneeAngle = angle(rightHip, rightKnee, rightAnkle);

  // 曲げている足と伸ばしている足の判定
  const angleDiff = Math.abs(leftKneeAngle - rightKneeAngle);
  const oneLegBent = angleDiff > 25 && Math.min(leftKneeAngle, rightKneeAngle) < 145;
  const standingStraight = Math.max(leftKneeAngle, rightKneeAngle) > 155;

  // 上半身の傾きチェック（肩の中心軸と腰の中心軸）
  const shoulderMid = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
  const hipMid = { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 };
  const torsoTilt = Math.abs(Math.atan2(shoulderMid.x - hipMid.x, hipMid.y - shoulderMid.y) * 180 / Math.PI);
  const torsoOk = torsoTilt < 15;

  // スコア計算
  let score = 40;
  if (oneLegBent) score += 30;
  if (standingStraight) score += 15;
  if (torsoOk) score += 15;
  score = Math.max(20, Math.min(100, Math.round(score)));

  // UI反映
  $('score').textContent = score;
  $('scoreBar').style.width = score + '%';
  $('verdict').textContent = score >= 80 ? '素晴らしい姿勢です！' : score >= 60 ? '形を整えましょう' : 'ポーズを作ってみよう';
  $('scoreCaption').textContent = '映像からの簡易推定スコアです。無理のない範囲で行ってください。';

  setCheck('torsoCheck', torsoOk ? '体幹が安定' : '上半身に傾きあり', torsoOk ? 'good' : 'warn');
  setCheck('balanceCheck', oneLegBent ? '片足を保持中' : '両足立ちに近い', oneLegBent ? 'good' : 'warn');
  setCheck('bodyCheck', '正常検出', 'good');

  // アドバイスの振り分け
  if (!oneLegBent) {
    showAdvice('片足を曲げてみよう', '木のポーズでは、片足を曲げて足裏を反対側の脚に添えます。膝に直接押し当てないよう注意。', '↗');
  } else if (!torsoOk) {
    showAdvice('上半身を真っ直ぐに', '体幹が傾いています。おへそを正面に向け、背筋をすっと伸ばしてみましょう。', '↕');
  } else {
    showAdvice('とても綺麗なポーズ！', '視線を正面の一点に固定し、ゆっくりと深い呼吸を続けましょう。', '✦');
  }
}

// カメラ起動
async function startCamera() {
  if (running) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    showAdvice('カメラを起動できません', 'HTTPS通信またはlocalhost環境でアクセスしてください。', '!');
    setStatus('利用不可');
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = '準備中…';

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    video.srcObject = stream;
    await new Promise(resolve => { video.onloadedmetadata = resolve; });
    await video.play();

    setStatus('カメラ起動中', true);
    placeholder.classList.add('hidden');
    stopBtn.disabled = false;
    startBtn.textContent = '実行中';
    running = true;

    $('trackingTag').textContent = '● モデル読み込み中…';

    if (!landmarker) {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numPoses: 1
      });
    }

    resizeCanvas();
    $('trackingTag').textContent = '● リアルタイム解析中';
    showAdvice('ポーズを始めましょう', '画面に全身を収め、ゆっくり木のポーズをとってください。', '✦');

    if (rafId) cancelAnimationFrame(rafId);
    loop();
  } catch (err) {
    console.error(err);
    stopCamera();
    const msg = err?.name === 'NotAllowedError'
      ? 'ブラウザのカメラアクセスを許可してください。'
      : 'カメラまたはAIモデルの起動に失敗しました。';
    showAdvice('起動エラー', msg, '!');
    setStatus('起動エラー');
    startBtn.disabled = false;
    startBtn.textContent = '再試行';
  }
}

// メインループ
function loop() {
  if (!running || !landmarker) return;

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    
    // detectForVideo を実行
    const result = landmarker.detectForVideo(video, performance.now());
    resizeCanvas();

    const rect = video.getBoundingClientRect();
    if (result.landmarks?.length) {
      drawSkeleton(result.landmarks[0], rect.width, rect.height);
      evaluate(result.landmarks[0]);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      $('trackingTag').textContent = '● 人物を探しています';
      setCheck('bodyCheck', '未検出', 'warn');
      showAdvice('カメラに全身を映してください', '頭から足先まで画面に入る位置へ移動してください。', '◎');
    }
  }

  rafId = requestAnimationFrame(loop);
}

// カメラ停止処理
function stopCamera() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  video.srcObject = null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  placeholder.classList.remove('hidden');

  setStatus('カメラ停止中');
  $('trackingTag').textContent = '● 骨格トラッキング待機中';
  startBtn.disabled = false;
  startBtn.textContent = 'カメラを起動';
  stopBtn.disabled = true;

  $('score').textContent = '--';
  $('scoreBar').style.width = '0%';
  $('verdict').textContent = 'カメラを起動してください';
  $('scoreCaption').textContent = '全身が映ると判定が始まります。';

  setCheck('torsoCheck', '待機中');
  setCheck('balanceCheck', '待機中');
  setCheck('bodyCheck', '未検出');
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeunload', stopCamera);
