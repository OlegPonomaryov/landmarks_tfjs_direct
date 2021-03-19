const FACE_DETECT_SIZE = 128;
const FACE_MESH_SIZE = 192;


const inputVideo = document.getElementById("inputVideo");
const outputCanvas = document.getElementById("outputCanvas");
const outputCanvasContext = outputCanvas.getContext("2d");
const backendOutput = document.getElementById("backendOutput");


async function main(blazefaceAnchors) {
  loadSettings();

  const faceDetModel = await tf.loadGraphModel("https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1", { fromTFHub: true });
  const faceMeshModel = await tf.loadGraphModel("https://tfhub.dev/mediapipe/tfjs-model/facemesh/1/default/1", { fromTFHub: true });

  const webcam = await tf.data.webcam(inputVideo);

  const sourceSize = [inputVideo.videoHeight, inputVideo.videoWidth]
  outputCanvas.height = sourceSize[0];
  outputCanvas.width = sourceSize[1];

  const faceDetSize = sourceSize[0] > sourceSize[1] ?
    [FACE_DETECT_SIZE, Math.round(sourceSize[1] * FACE_DETECT_SIZE / sourceSize[0])] :
    (sourceSize[1] > sourceSize[0] ?
      [Math.round(sourceSize[0] * FACE_DETECT_SIZE / sourceSize[1]), FACE_DETECT_SIZE] :
      [FACE_DETECT_SIZE, FACE_DETECT_SIZE]);

  const faceDetPadding = [[Math.ceil((FACE_DETECT_SIZE - faceDetSize[0]) / 2), Math.floor((FACE_DETECT_SIZE - faceDetSize[0]) / 2)],
  [Math.ceil((FACE_DETECT_SIZE - faceDetSize[1]) / 2), Math.floor((FACE_DETECT_SIZE - faceDetSize[1]) / 2)],
  [0, 0]]

  outputCanvasContext.font = "18px Arial MS";

  let fpsEMA = -1,
    prevFrameTime = -1,
    approxFaceRect = null;
  while (true) {
    const img = await webcam.capture();

    let faceRect;
    if (approxFaceRect != null) {
      padRect(approxFaceRect, sourceSize, 0.25);
      faceRect = approxFaceRect;
    }
    else {
      faceRect = await detectFaceRect(faceDetModel, img, sourceSize, faceDetSize, faceDetPadding, blazefaceAnchors);
    }

    let faceMesh = null;
    if (faceRect[0] > 0.9) {
      faceMesh = await detectFaceMesh(faceMeshModel, img, faceRect);
      if (faceMesh[0] > 0.5) {
        approxFaceRect = faceMesh[2];
      }
    }

    outputCanvasContext.drawImage(inputVideo, 0, 0);
    if (faceMesh != null && faceMesh[0] > 0.5) {
      plotLandmarks(faceMesh[1]);
    }

    let currFrameTime = Date.now();
    if (prevFrameTime >= 0) {
      fpsEMA = calcFPS(prevFrameTime, currFrameTime, fpsEMA);
    }
    outputCanvasContext.fillStyle = "red";
    outputCanvasContext.fillText(Math.round(fpsEMA) + " FPS", 5, 20);
    prevFrameTime = currFrameTime;

    img.dispose();

    await tf.nextFrame();
  }
}

function loadSettings() {
  let url = new URL(window.location.href);

  let backend = url.searchParams.get("back") ?? "webgl";
  tf.setBackend(backend);
  backendOutput.innerText = "Backend: " + tf.getBackend();
}

async function detectFaceRect(faceDetModel, img, sourceSize, targetSize, padding, anchors) {
  const faceDetInput = tf.tidy(() => preprocessFaceDet(img, targetSize, padding));

  let predictions = await faceDetModel.predict(faceDetInput);
  faceDetInput.dispose();

  const result = tf.tidy(() => getBestRect(predictions, anchors));
  predictions.dispose();

  const faceRect = await result[0].data();
  result[0].dispose();
  const anchor = await result[1].data();
  result[1].dispose();

  postprocessFaceRect(faceRect, anchor, sourceSize, targetSize, padding);

  return faceRect;
}

function preprocessFaceDet(img, targetSize, padding) {
  /* Transforms the input image into a (128 x 128) tensor while keeping the aspect
   * ratio (what is expected by the corresponding face detection model), resulting
   * in potential letterboxing in the transformed image.
   */

  const scale = tf.scalar(127.5);
  const offset = tf.scalar(1);
  const result = img.resizeBilinear(targetSize)
    .div(scale)
    .sub(offset)
    .pad(padding, 0)
    .reshape([1, FACE_DETECT_SIZE, FACE_DETECT_SIZE, 3]);
  return result;
}

function getBestRect(predictions, anchors) {
  const squeezedPred = predictions.squeeze();
  const logits = squeezedPred.slice([0, 0], [-1, 1]).squeeze();
  const bestRectIDX = logits.argMax();
  const bestPred = squeezedPred.gather(bestRectIDX).squeeze();
  const bestRect = bestPred.slice(0, 5);
  const anchor = anchors.gather(bestRectIDX).squeeze();
  return [bestRect, anchor];
}

function postprocessFaceRect(rect, anchor, sourceSize, targetSize, padding) {
  rect[0] = 1 / (1 + Math.exp(-rect[0]));

  rect[1] += anchor[0] * FACE_DETECT_SIZE - padding[1][0];
  rect[2] += anchor[1] * FACE_DETECT_SIZE - padding[0][0];
  rect[3] *= anchor[2];
  rect[4] *= anchor[3];

  scale = sourceSize[0] / targetSize[0];
  for (let i = 1; i < 5; i++) {
    rect[i] *= scale;
  }

  rect[1] -= rect[3] / 2;
  rect[2] -= rect[4] / 2;
  rect[3] += rect[1];
  rect[4] += rect[2];

  padRect(rect, sourceSize, 0.25);
}

function padRect(rect, sourceSize, scale) {
  const widthPad = Math.round((rect[3] - rect[1]) * scale),
    heightPad = Math.round((rect[4] - rect[2]) * scale);
  for (let i = 1; i < 5; i++) {
    rect[i] = Math.round(rect[i]);
  }

  rect[1] -= widthPad;
  rect[3] += widthPad;
  rect[2] -= heightPad;
  rect[4] += heightPad;

  rect[1] = Math.max(0, rect[1]);
  rect[2] = Math.max(0, rect[2]);
  rect[3] = Math.min(sourceSize[1] - 1, rect[3]);
  rect[4] = Math.min(sourceSize[0] - 1, rect[4]);
}


function plotFaceRect(faceRect) {
  outputCanvasContext.strokeStyle = "purple";
  outputCanvasContext.lineWidth = 2;
  outputCanvasContext.beginPath();
  outputCanvasContext.rect(
    faceRect[1], faceRect[2], faceRect[3] - faceRect[1], faceRect[4] - faceRect[2]);
  outputCanvasContext.stroke();
}


async function detectFaceMesh(faceMeshModel, img, faceRect) {
  const faceMeshInput = tf.tidy(() => preprocessFaceMesh(img, faceRect));

  const predictions = await faceMeshModel.predict(faceMeshInput);
  faceMeshInput.dispose();

  const result = tf.tidy(() => postprocessFaceMesh(predictions, faceRect));

  const faceProb = (await result[0].data())[0];
  result[0].dispose();
  const faceMesh = await result[1].array();
  result[1].dispose();

  faceRect = [1]
  for (let i = 0; i < result[2].length; ++i) {
    const coord = await result[2][i].data();
    faceRect.push(coord[0]);
    result[2][i].dispose();
  }

  for (let i = 0; i < predictions.length; i++) {
    predictions[i].dispose();
  }

  return [faceProb, faceMesh, faceRect];
}

function preprocessFaceMesh(img, faceRect) {
  const scale = tf.scalar(255);
  const result = img
    .slice([faceRect[2], faceRect[1], 0],
      [faceRect[4] - faceRect[2], faceRect[3] - faceRect[1], -1])
    .resizeBilinear([FACE_MESH_SIZE, FACE_MESH_SIZE])
    .div(scale)
    .reshape([1, FACE_MESH_SIZE, FACE_MESH_SIZE, 3]);
  return result;
}

function postprocessFaceMesh(predictions, faceRect) {
  const prob = predictions[1];
  const scale = tf.tensor([(faceRect[3] - faceRect[1]) / FACE_MESH_SIZE, (faceRect[4] - faceRect[2]) / FACE_MESH_SIZE, 1])
  const offset = tf.tensor([faceRect[1], faceRect[2], 0])
  const predMesh = predictions[2].reshape([-1, 3]);
  const mesh = predMesh.mul(scale).add(offset);
  const x = mesh.slice([0, 0], [-1, 1]);
  const y = mesh.slice([0, 1], [-1, 1]);
  return [prob, mesh, [x.min(), y.min(), x.max(), y.max()]];
}

function plotLandmarks(predictions) {
  outputCanvasContext.fillStyle = "green";
  for (let i = 0; i < predictions.length; i++) {
    outputCanvasContext.beginPath();
    outputCanvasContext.arc(Math.round(predictions[i][0]), Math.round(predictions[i][1]), 2, 0, 2 * Math.PI);
    outputCanvasContext.fill();
  }
}

function calcFPS(prevFrameTime, currFrameTime, fpsEMA) {
  let currFPS = 1000 / (currFrameTime - prevFrameTime);
  if (fpsEMA >= 0) {
    fpsEMA = 0.05 * currFPS + (1 - 0.05) * fpsEMA;
  }
  else {
    fpsEMA = currFPS;
  }
  return fpsEMA;
}
