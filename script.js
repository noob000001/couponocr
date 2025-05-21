document.addEventListener('DOMContentLoaded', () => {
    const videoElement = document.getElementById('camera-feed');
    const captureCanvas = document.getElementById('capture-canvas');
    const scanWindow = document.querySelector('.scan-window');
    // scanWindowOverlay는 직접적인 계산보다는 videoElement의 크기를 기준으로 함
    const couponLengthInput = document.getElementById('coupon-length');
    const couponFormatSelect = document.getElementById('coupon-format');
    const captureBtn = document.getElementById('capture-btn');
    const ocrStatusElement = document.getElementById('ocr-status');
    const ocrRawDebugOutputElement = document.getElementById('ocr-raw-debug-output');
    const recognizedCodeCandidateElement = document.getElementById('recognized-code-candidate');
    const addToListBtn = document.getElementById('add-to-list-btn');
    const couponListULElement = document.getElementById('coupon-list');
    const couponCountElement = document.getElementById('coupon-count');
    // (기타 버튼 요소들은 이전과 동일하게 가져옴)
    const copyAllBtn = document.getElementById('copy-all-btn');
    const shareAllBtn = document.getElementById('share-all-btn');
    const exportTxtBtn = document.getElementById('export-txt-btn');
    const deleteAllBtn = document.getElementById('delete-all-btn');

    let localStream = null;
    let tesseractScheduler = null;
    let tesseractWorkersCount = 1;
    let coupons = [];
    let currentCandidateCode = null;
    const TESS_WHITELIST = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-';

    async function initialize() {
        console.log("App initializing...");
        ocrStatusElement.textContent = 'OCR 엔진을 로드 중입니다...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        try {
            tesseractScheduler = Tesseract.createScheduler();
            for (let i = 0; i < tesseractWorkersCount; i++) {
                const worker = await Tesseract.createWorker('kor+eng', 1, {});
                await worker.setParameters({ tessedit_char_whitelist: TESS_WHITELIST });
                tesseractScheduler.addWorker(worker);
            }
            console.log("Tesseract workers initialized.");
            ocrStatusElement.textContent = '카메라를 준비 중입니다...';
            await setupCamera();
            loadSettings(); loadCoupons(); setupEventListeners(); updateCouponCount();
            ocrStatusElement.textContent = '준비 완료. 쿠폰을 스캔 창에 맞춰주세요.';
            console.log("App initialization complete.");
        } catch (error) {
            console.error("초기화 중 오류:", error);
            ocrStatusElement.textContent = `초기화 오류: ${error.message}`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `초기화 오류: ${error.message}`;
            alert(`초기화 오류: ${error.message}. 페이지를 새로고침하거나 권한을 확인하세요.`);
        }
    }

    async function setupCamera() {
        console.log("Setting up camera...");
        try {
            if (localStream) { localStream.getTracks().forEach(track => track.stop()); }
            const constraints = { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            videoElement.srcObject = localStream;
            await videoElement.play();
            captureBtn.disabled = false;
            ocrStatusElement.textContent = '카메라 준비 완료.';
            console.log("Camera setup complete.");
        } catch (err) {
            console.error("카메라 접근 오류:", err);
            ocrStatusElement.textContent = '카메라 접근 실패.';
            captureBtn.disabled = true;
            alert('카메라 접근에 실패했습니다. 권한을 확인하고 새로고침해주세요.');
        }
    }
    
    function loadSettings() { /* 이전과 동일 */ 
        const savedLength = localStorage.getItem('couponScanner_couponLength');
        if (savedLength) couponLengthInput.value = savedLength;
        const savedFormat = localStorage.getItem('couponScanner_couponFormat');
        if (savedFormat) couponFormatSelect.value = savedFormat;
        console.log("Settings loaded.");
    }
    function saveSettings() { /* 이전과 동일 */ 
        localStorage.setItem('couponScanner_couponLength', couponLengthInput.value);
        localStorage.setItem('couponScanner_couponFormat', couponFormatSelect.value);
        console.log("Settings saved.");
    }
    function setupEventListeners() { /* 이전과 동일 (최적화된 삭제 리스너 포함) */ 
        captureBtn.addEventListener('click', handleManualCapture);
        addToListBtn.addEventListener('click', addCandidateToList);
        couponLengthInput.addEventListener('change', saveSettings);
        couponFormatSelect.addEventListener('change', saveSettings); 
        copyAllBtn.addEventListener('click', copyAllCouponsToClipboard);
        shareAllBtn.addEventListener('click', shareAllCoupons);
        exportTxtBtn.addEventListener('click', exportCouponsAsTextFile);
        deleteAllBtn.addEventListener('click', deleteAllCoupons);
        couponListULElement.addEventListener('click', function(event) {
            if (event.target && event.target.classList.contains('delete-item-btn')) {
                const codeToDelete = event.target.dataset.code;
                const listItemElement = event.target.closest('li');
                deleteCoupon(codeToDelete, listItemElement);
            }
        });
        console.log("Event listeners setup.");
    }

    // === 이미지 잘라내기 로직: object-fit: cover 상황에 맞춰 전면 재검토 ===
    async function handleManualCapture() {
        console.log("--- handleManualCapture: Starting ---");
        if (!localStream || !videoElement.srcObject || videoElement.readyState < videoElement.HAVE_METADATA || videoElement.videoWidth === 0) {
            ocrStatusElement.textContent = '카메라가 준비되지 않았거나 영상 크기를 알 수 없습니다.';
            console.warn("Camera not ready or video dimensions are zero.");
            return;
        }
        // (Tesseract 준비 상태 확인은 이전과 동일)
        if (!tesseractScheduler || tesseractScheduler.getNumWorkers() === 0) { 
            ocrStatusElement.textContent = 'OCR 엔진 준비 중...'; return;
        }


        captureBtn.disabled = true;
        addToListBtn.style.display = 'none';
        recognizedCodeCandidateElement.textContent = '';
        ocrStatusElement.textContent = '이미지 캡처 중...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';

        try {
            const vidIntrinsicW = videoElement.videoWidth;  // 원본 비디오 너비
            const vidIntrinsicH = videoElement.videoHeight; // 원본 비디오 높이
            const vidElemDisplayedW = videoElement.offsetWidth;  // 화면에 표시된 비디오 요소의 너비
            const vidElemDisplayedH = videoElement.offsetHeight; // 화면에 표시된 비디오 요소의 높이 (aspect-ratio에 의해 결정됨)

            console.log(`Video Intrinsic: ${vidIntrinsicW}x${vidIntrinsicH}`);
            console.log(`Video Element Displayed: ${vidElemDisplayedW}x${vidElemDisplayedH}`);

            // CSS에서 .scanner-area가 aspect-ratio를 갖고, videoElement가 width:100%, height:100%, object-fit:cover 이므로,
            // videoElement.offsetWidth/Height가 바로 "cover"된 화면에 보이는 비디오 영역의 크기가 된다.
            // 원본 비디오에서 이 보이는 영역에 해당하는 소스 사각형(sx, sy, sWidth, sHeight)을 계산한다.
            const vidAR = vidIntrinsicW / vidIntrinsicH;
            const elemAR = vidElemDisplayedW / vidElemDisplayedH; // .scanner-area의 CSS aspect-ratio와 일치해야 함

            let sx = 0, sy = 0, sRenderedWidth = vidIntrinsicW, sRenderedHeight = vidIntrinsicH;

            if (vidAR > elemAR) { // 비디오 원본이 요소보다 옆으로 더 넓다 (좌우가 잘림)
                sRenderedHeight = vidIntrinsicH; // 높이는 원본 전체 사용
                sRenderedWidth = vidIntrinsicH * elemAR; // 요소 비율에 맞춘 소스 너비
                sx = (vidIntrinsicW - sRenderedWidth) / 2; // 원본에서 잘라낼 시작 X점
                sy = 0;
            } else if (vidAR < elemAR) { // 비디오 원본이 요소보다 위아래로 더 길다 (위아래가 잘림)
                sRenderedWidth = vidIntrinsicW; // 너비는 원본 전체 사용
                sRenderedHeight = vidIntrinsicW / elemAR; // 요소 비율에 맞춘 소스 높이
                sx = 0;
                sy = (vidIntrinsicH - sRenderedHeight) / 2; // 원본에서 잘라낼 시작 Y점
            }
            // 비율이 같으면 sx=0, sy=0, sRenderedWidth=vidIntrinsicW, sRenderedHeight=vidIntrinsicH

            console.log(`Source rect from intrinsic video (part visible due to 'cover'): sx=${sx.toFixed(2)}, sy=${sy.toFixed(2)}, sRenderedWidth=${sRenderedWidth.toFixed(2)}, sRenderedHeight=${sRenderedHeight.toFixed(2)}`);

            // 스캔 창(.scan-window)은 .scanner-area (.videoElement의 부모이자 크기 동일) 기준으로 % 크기를 가짐
            // 화면에 보이는 스캔 창의 크기와 위치를 가져온다.
            const scanWindowRect = scanWindow.getBoundingClientRect();
            const videoElementRect = videoElement.getBoundingClientRect(); // videoElement의 화면상 위치

            // 화면에 보이는 videoElement 영역 내에서 스캔창의 상대적 위치와 크기 (픽셀 단위)
            const scanRelX = scanWindowRect.left - videoElementRect.left;
            const scanRelY = scanWindowRect.top - videoElementRect.top;
            const scanRelW = scanWindowRect.width;
            const scanRelH = scanWindowRect.height;
            console.log(`Scan window visual rect (relative to video element): x=${scanRelX.toFixed(2)}, y=${scanRelY.toFixed(2)}, w=${scanRelW.toFixed(2)}, h=${scanRelH.toFixed(2)}`);

            // 이 상대적 위치/크기를 "cover"로 인해 실제로 보이는 원본 비디오 부분(sRenderedWidth, sRenderedHeight)에 대한 비율로 변환
            // 그리고 그 비율을 sx, sy를 기준으로 원본 비디오의 절대 좌표로 다시 변환
            const finalCropX = sx + (scanRelX / vidElemDisplayedW) * sRenderedWidth;
            const finalCropY = sy + (scanRelY / vidElemDisplayedH) * sRenderedHeight;
            const finalCropWidth = (scanRelW / vidElemDisplayedW) * sRenderedWidth;
            const finalCropHeight = (scanRelH / vidElemDisplayedH) * sRenderedHeight;

            console.log(`Final crop area on intrinsic video: sx=${finalCropX.toFixed(2)}, sy=${finalCropY.toFixed(2)}, sWidth=${finalCropWidth.toFixed(2)}, sHeight=${finalCropHeight.toFixed(2)}`);

            if (finalCropWidth <= 0 || finalCropHeight <= 0 || finalCropX < -0.5 || finalCropY < -0.5 ||
                (finalCropX + finalCropWidth > vidIntrinsicW + 0.5) ||
                (finalCropY + finalCropHeight > vidIntrinsicH + 0.5)) {
                console.error("최종 잘라낼 영역 계산 오류:", { finalCropX, finalCropY, finalCropWidth, finalCropHeight });
                throw new Error("스캔 창 영역 계산 오류 (최종).");
            }

            captureCanvas.width = Math.round(finalCropWidth);
            captureCanvas.height = Math.round(finalCropHeight);
            const context = captureCanvas.getContext('2d');
            context.drawImage(videoElement, finalCropX, finalCropY, finalCropWidth, finalCropHeight, 0, 0, captureCanvas.width, captureCanvas.height);
            console.log("Image drawn to canvas.");

            const imageDataUrl = captureCanvas.toDataURL('image/png');
            ocrStatusElement.textContent = '쿠폰 번호 인식 중...';
            const result = await tesseractScheduler.addJob('recognize', imageDataUrl);
            console.log("Tesseract result:", result);
            if (result && result.data && typeof result.data.text !== 'undefined') {
                processOCRResult(result.data.text);
            } else {
                throw new Error("OCR 엔진 결과에 텍스트가 없습니다.");
            }

        } catch (error) {
            console.error("캡처/OCR 처리 중 오류:", error);
            ocrStatusElement.textContent = `오류: ${error.message}`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `캡처/OCR 오류: ${error.message}`;
        } finally {
            captureBtn.disabled = false;
            console.log("--- handleManualCapture: Finished ---");
        }
    }
    // === 이미지 잘라내기 로직 수정 끝 ===


    // --- OCR 결과 처리 (이전과 동일) ---
    function processOCRResult(rawText) { /* ... 이전 코드와 동일 ... */ }
    // --- 쿠폰 목록 관리 (이전과 동일, 최적화된 삭제 로직 유지) ---
    function addCandidateToList() { /* ... 이전 코드와 동일 ... */ }
    function deleteCoupon(codeToDelete, listItemElement) { /* ... 이전 코드와 동일 ... */ }
    function deleteAllCoupons() { /* ... 이전 코드와 동일 ... */ }
    function renderCouponList() { /* ... 이전 코드와 동일 ... */ }
    function saveCoupons() { /* ... 이전 코드와 동일 ... */ }
    function loadCoupons() { /* ... 이전 코드와 동일 ... */ }
    function updateCouponCount() { /* ... 이전 코드와 동일 ... */ }
    // --- 내보내기/공유 기능 (이전과 동일) ---
    function getFormattedCouponText() { /* ... 이전 코드와 동일 ... */ }
    function copyAllCouponsToClipboard() { /* ... 이전 코드와 동일 ... */ }
    async function shareAllCoupons() { /* ... 이전 코드와 동일 ... */ }
    function exportCouponsAsTextFile() { /* ... 이전 코드와 동일 ... */ }

    initialize();
});
