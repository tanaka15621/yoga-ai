const video = document.getElementById("video");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const placeholder = document.getElementById("placeholder");
const status = document.getElementById("status");

let stream = null;

startButton.addEventListener("click", async () => {
  try {
    status.textContent = "カメラを起動しています…";

    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    placeholder.classList.add("hidden");
    status.textContent = "✅ カメラが起動しました！";
    startButton.disabled = true;
    stopButton.disabled = false;

  } catch (error) {
    console.error(error);
    status.textContent = "❌ カメラを起動できませんでした: " + error.name;
    alert("カメラを起動できませんでした。ブラウザのカメラ許可を確認してください。");
  }
});

stopButton.addEventListener("click", () => {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  stream = null;
  video.srcObject = null;
  placeholder.classList.remove("hidden");
  status.textContent = "カメラを停止しました";
  startButton.disabled = false;
  stopButton.disabled = true;
});
