document.addEventListener('DOMContentLoaded', () => {
    const videoElement = document.getElementById('camera-feed');
    const captureCanvas = document.getElementById('capture-canvas');
    const scanWindowOverlay = document.querySelector('.scan-window-overlay');
    const scanWindow = document.querySelector('.scan-window');
    const couponLengthInput = document.getElementById('coupon-length');
    const couponFormatSelect = document.getElementById('coupon-format');
    const captureBtn = document.getElementById('capture-btn');
    const ocrStatusElement = document.getElementById('ocr-status');
    const ocrRawDebugOutputElement = document.getElementById('ocr-raw-debug-output');
    const recognizedCodeCandidateElement = document.getElementById('recognized-code-candidate');
    const addToListBtn = document.getElementById('add-to-list-btn');
    const couponListULElement = document.getElementById('coupon-list');
    const couponCountElement = document.getElementById('coupon-count');
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
            const workerPromises = [];
            for (let i = 0; i < tesseractWorkersCount; i++) {
                const worker = await Tesseract.createWorker('kor+eng', 1, {
                    // logger: m => console.log(m) // 필요시 진행 상황 로깅
                });
                await worker.setParameters({
                    tessedit_char_whitelist: TESS_WHITELIST,
                });
                tesseractScheduler.addWorker(worker);
                workerPromises.push(Promise.resolve());
            }
            await Promise.all(workerPromises);
            console.log("Tesseract workers initialized.");
            ocrStatusElement.textContent = '카메라를 준비 중입니다... 권한을 허용해주세요.';
            await setupCamera();
            loadSettings(); loadCoupons(); setupEventListeners(); updateCouponCount();
            ocrStatusElement.textContent = '준비 완료. 쿠폰을 스캔 창에 맞춰주세요.';
            console.log("App initialization complete.");
        } catch (error) {
            console.error("초기화 중 오류 발생:", error);
            ocrStatusElement.textContent = `오류: ${error.message}. 카메라/OCR 초기화 실패.`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `초기화 오류: ${error.message}`;
            alert(`오류: ${error.message}. 페이지를 새로고침하거나 카메라 권한을 확인해주세요.`);
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
            ocrStatusElement.textContent = '카메라 접근에 실패했습니다. 권한을 확인해주세요.';
            captureBtn.disabled = true;
            alert('카메라 접근에 실패했습니다. 페이지를 새로고침하고 권한을 허용해주세요.');
        }
    }

    function loadSettings() {
        const savedLength = localStorage.getItem('couponScanner_couponLength');
        if (savedLength) couponLengthInput.value = savedLength;
        const savedFormat = localStorage.getItem('couponScanner_couponFormat');
        if (savedFormat) couponFormatSelect.value = savedFormat;
        console.log("Settings loaded.");
    }
    function saveSettings() {
        localStorage.setItem('couponScanner_couponLength', couponLengthInput.value);
        localStorage.setItem('couponScanner_couponFormat', couponFormatSelect.value);
        console.log("Settings saved.");
    }

    function setupEventListeners() {
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

    // === 이미지 잘라내기 로직: object-fit: contain 상황을 고려하여 재수정 ===
    async function handleManualCapture() {
        if (!localStream || !videoElement.srcObject || videoElement.readyState < videoElement.HAVE_METADATA) {
            ocrStatusElement.textContent = '카메라가 준비되지 않았습니다.'; return;
        }
        if (!tesseractScheduler || tesseractScheduler.getNumWorkers() === 0) {
            ocrStatusElement.textContent = 'OCR 엔진 준비 중...'; return;
        }

        captureBtn.disabled = true;
        addToListBtn.style.display = 'none';
        recognizedCodeCandidateElement.textContent = '';
        ocrStatusElement.textContent = '이미지 캡처 중...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        console.log("handleManualCapture started");

        try {
            const videoIntrinsicWidth = videoElement.videoWidth;
            const videoIntrinsicHeight = videoElement.videoHeight;
            const videoAspectRatio = videoIntrinsicWidth / videoIntrinsicHeight;

            // videoElement는 CSS의 object-fit: contain 에 의해 스케일링되고 레터박스가 생길 수 있음
            // videoElement의 화면상 실제 크기
            const videoElemClientWidth = videoElement.clientWidth;
            const videoElemClientHeight = videoElement.clientHeight;
            const elemAspectRatio = videoElemClientWidth / videoElemClientHeight;

            // videoElement 내에서 실제 비디오 내용이 그려지는 유효 영역 계산
            let renderedVideoWidth, renderedVideoHeight, offsetX, offsetY;
            if (videoAspectRatio > elemAspectRatio) { // 비디오가 요소보다 넓음 (위아래 레터박스)
                renderedVideoWidth = videoElemClientWidth;
                renderedVideoHeight = videoElemClientWidth / videoAspectRatio;
                offsetX = 0;
                offsetY = (videoElemClientHeight - renderedVideoHeight) / 2;
            } else { // 비디오가 요소보다 길거나 같음 (좌우 레터박스 또는 꽉참)
                renderedVideoHeight = videoElemClientHeight;
                renderedVideoWidth = videoElemClientHeight * videoAspectRatio;
                offsetX = (videoElemClientWidth - renderedVideoWidth) / 2;
                offsetY = 0;
            }
            console.log("Rendered video dimensions within element:", { renderedVideoWidth, renderedVideoHeight, offsetX, offsetY });

            // 스캔 창의 화면상 위치와 크기 (videoElement 기준이 아닌, 전체 document 기준)
            const scanWindowRect = scanWindow.getBoundingClientRect();
            // videoElement의 화면상 위치
            const videoElementRect = videoElement.getBoundingClientRect();

            // 스캔 창의 시작점이 videoElement의 (0,0)을 기준으로 어디서 시작하는지 (레터박스 포함된 영역 기준)
            let scanVisualX = scanWindowRect.left - videoElementRect.left;
            let scanVisualY = scanWindowRect.top - videoElementRect.top;
            let scanVisualWidth = scanWindowRect.width;
            let scanVisualHeight = scanWindowRect.height;

            // 스캔 창 좌표를 실제 비디오 내용 영역 기준으로 변환
            scanVisualX = scanVisualX - offsetX;
            scanVisualY = scanVisualY - offsetY;

            // 변환된 좌표가 실제 비디오 내용 영역을 벗어나지 않도록 클리핑
            scanVisualX = Math.max(0, scanVisualX);
            scanVisualY = Math.max(0, scanVisualY);

            // 스캔 창의 끝점이 실제 비디오 내용 영역을 벗어나지 않도록 너비/높이 조절
            scanVisualWidth = Math.min(scanVisualWidth, renderedVideoWidth - scanVisualX);
            scanVisualHeight = Math.min(scanVisualHeight, renderedVideoHeight - scanVisualY);
            
            console.log("Visual scan area relative to rendered video content:",{ scanVisualX, scanVisualY, scanVisualWidth, scanVisualHeight });

            if (scanVisualWidth <= 0 || scanVisualHeight <= 0) {
                throw new Error("스캔 창 영역이 유효하지 않습니다 (크기가 0 또는 음수).");
            }

            // 원본 비디오 해상도에서 잘라낼 소스(source) 영역 계산
            // (화면에 보이는 스캔창 영역 / 화면에 보이는 비디오 영역) * 원본 비디오 해상도
            const sx = (scanVisualX / renderedVideoWidth) * videoIntrinsicWidth;
            const sy = (scanVisualY / renderedVideoHeight) * videoIntrinsicHeight;
            const sWidth = (scanVisualWidth / renderedVideoWidth) * videoIntrinsicWidth;
            const sHeight = (scanVisualHeight / renderedVideoHeight) * videoIntrinsicHeight;
            
            console.log("Source crop area for drawImage (intrinsic video resolution):", { sx, sy, sWidth, sHeight });

            if (sWidth <= 0 || sHeight <= 0 || sx < 0 || sy < 0 ||
                (sx + sWidth > videoIntrinsicWidth + 1) || // 부동소수점 오차 감안 +1
                (sy + sHeight > videoIntrinsicHeight + 1) ) {
                console.error("최종 원본 비디오 잘라낼 영역 계산 오류:", {sx, sy, sWidth, sHeight});
                throw new Error("잘라낼 원본 비디오 영역 계산에 오류가 있습니다.");
            }

            captureCanvas.width = sWidth;
            captureCanvas.height = sHeight;
            const context = captureCanvas.getContext('2d');
            context.drawImage(videoElement, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);
            console.log("Image drawn to canvas for OCR.");

            const imageDataUrl = captureCanvas.toDataURL('image/png');
            ocrStatusElement.textContent = '쿠폰 번호 인식 중... 잠시만 기다려주세요.';

            const result = await tesseractScheduler.addJob('recognize', imageDataUrl);
            console.log("Tesseract result:", result);
            processOCRResult(result.data.text);

        } catch (error) {
            console.error("캡처 또는 OCR 처리 중 오류:", error);
            ocrStatusElement.textContent = `오류 발생: ${error.message}`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `캡처/OCR 오류: ${error.message}`;
        } finally {
            captureBtn.disabled = false;
            console.log("handleManualCapture finished");
        }
    }
    // === 이미지 잘라내기 로직 수정 끝 ===

    function processOCRResult(rawText) { /* ... 이전 코드와 동일 ... */ 
        ocrStatusElement.textContent = '인식 완료. 결과 분석 중...'; console.log("원본 OCR 텍스트:", rawText);
        if (ocrRawDebugOutputElement) { ocrRawDebugOutputElement.textContent = `[OCR 원본]: "${rawText}" (길이: ${rawText ? rawText.length : 0})`; }
        let workingText = rawText ? rawText.replace(/\s+/g, '') : ''; const selectedFormat = couponFormatSelect.value; let finalFilteredText = '';
        if (selectedFormat === 'alphanumeric') {
            workingText = workingText.replace(/-/g, ''); finalFilteredText = workingText.replace(/[^A-Za-z0-9]/g, '');
        } else if (selectedFormat === 'alphanumeric_hyphen') {
            finalFilteredText = workingText.replace(/[^A-Za-z0-9\-]/g, '');
        } else { finalFilteredText = workingText.replace(/[^A-Za-z0-9]/g, ''); }
        console.log("선택 형식:", selectedFormat, " | 필터링 후:", finalFilteredText, " | 길이:", finalFilteredText.length);
        const lengthPattern = couponLengthInput.value.trim(); let minLength = 0, maxLength = Infinity;
        if (lengthPattern.includes('-')) {
            const parts = lengthPattern.split('-'); minLength = parseInt(parts[0], 10) || 0; maxLength = parseInt(parts[1], 10) || Infinity;
        } else if (lengthPattern) { minLength = parseInt(lengthPattern, 10) || 0; maxLength = minLength; }
        if (finalFilteredText.length >= minLength && finalFilteredText.length <= maxLength && finalFilteredText.length > 0) { 
            currentCandidateCode = finalFilteredText; recognizedCodeCandidateElement.textContent = currentCandidateCode;
            addToListBtn.style.display = 'inline-block'; ocrStatusElement.textContent = '인식된 번호를 확인하고 목록에 추가하세요.';
        } else {
            currentCandidateCode = null; recognizedCodeCandidateElement.textContent = '-'; addToListBtn.style.display = 'none';
            let message = `필터링 후 내용(${finalFilteredText})이 설정된 자릿수(${lengthPattern})와 맞지 않습니다.`;
            if (finalFilteredText.length === 0 && rawText && rawText.trim().length > 0) { message += ` (유효한 문자를 찾지 못함)`; }
            message += ` (OCR 원본은 위 파란색 텍스트 참고)`; ocrStatusElement.textContent = message;
        }
    }

    function addCandidateToList() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
        console.log("addCandidateToList called. currentCandidateCode:", currentCandidateCode);
        if (currentCandidateCode && !coupons.includes(currentCandidateCode)) {
            coupons.push(currentCandidateCode); saveCoupons(); renderCouponList(); updateCouponCount();
            ocrStatusElement.textContent = `"${currentCandidateCode}" 가 목록에 추가되었습니다.`;
            recognizedCodeCandidateElement.textContent = ''; addToListBtn.style.display = 'none'; currentCandidateCode = null;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = ''; 
        } else if (coupons.includes(currentCandidateCode)) { ocrStatusElement.textContent = '이미 목록에 있는 번호입니다.';
        } else if (!currentCandidateCode) { ocrStatusElement.textContent = '추가할 유효한 쿠폰 번호가 없습니다.'; }
        console.log("addCandidateToList finished. Coupons:", coupons);
    }
    
    function deleteCoupon(codeToDelete, listItemElement) { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
        console.log("--- deleteCoupon initiated ---");
        console.log("Attempting to delete code:", codeToDelete, "| Type:", typeof codeToDelete);
        console.log("Coupons array BEFORE deletion:", JSON.parse(JSON.stringify(coupons)));
        const initialLength = coupons.length;
        coupons = coupons.filter(code => code !== codeToDelete);
        const newLength = coupons.length;
        console.log("Coupons array AFTER deletion:", JSON.parse(JSON.stringify(coupons)));
        if (initialLength !== newLength) { 
            console.log("Code was found and removed from array. Now calling saveCoupons...");
            saveCoupons();
            if (listItemElement && listItemElement.parentNode === couponListULElement) {
                console.log("Attempting to remove specific li element from DOM:", listItemElement);
                couponListULElement.removeChild(listItemElement);
                console.log("Specific li element removed from DOM.");
            } else {
                console.warn("listItemElement not provided or invalid for direct DOM removal. Falling back to full renderCouponList.");
                renderCouponList();
            }
            console.log("Now calling updateCouponCount...");
            updateCouponCount();
            ocrStatusElement.textContent = `"${codeToDelete}" 가 목록에서 삭제되었습니다.`;
        } else {
            console.log("Code not found in coupons array, no deletion performed from array.");
            ocrStatusElement.textContent = `"${codeToDelete}" 는 목록에 없습니다.`;
        }
        console.log("--- deleteCoupon finished ---");
    }

    function deleteAllCoupons() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
        console.log("--- deleteAllCoupons initiated ---");
        if (coupons.length === 0) { ocrStatusElement.textContent = '삭제할 쿠폰이 없습니다.'; return; }
        if (confirm('정말로 모든 쿠폰 목록을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
            coupons = []; saveCoupons(); renderCouponList(); updateCouponCount();
            ocrStatusElement.textContent = '모든 쿠폰이 삭제되었습니다.';
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
            console.log("All coupons deleted.");
        }
        console.log("--- deleteAllCoupons finished ---");
    }

    function renderCouponList() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
        console.log("--- renderCouponList initiated. Number of coupons to render:", coupons.length);
        couponListULElement.innerHTML = ''; 
        console.log("Coupon list UL cleared.");
        if (coupons.length === 0) {
            const li = document.createElement('li'); li.textContent = '저장된 쿠폰이 없습니다.';
            li.style.textAlign = 'center'; li.style.color = '#7f8c8d';
            couponListULElement.appendChild(li);
            console.log("Displayed 'No coupons' message.");
        } else {
            coupons.forEach((code, index) => {
                const li = document.createElement('li'); 
                const codeSpan = document.createElement('span'); codeSpan.textContent = code; li.appendChild(codeSpan);
                const deleteBtn = document.createElement('button'); deleteBtn.textContent = '삭제';
                deleteBtn.classList.add('delete-item-btn'); deleteBtn.dataset.code = code; 
                li.appendChild(deleteBtn); couponListULElement.appendChild(li);
            });
            console.log("All coupon items rendered.");
        }
        console.log("--- renderCouponList finished ---");
    }
    function saveCoupons() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
         localStorage.setItem('couponScanner_coupons', JSON.stringify(coupons)); 
        console.log("Coupons saved to localStorage.");
    }
    function loadCoupons() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
        const savedCoupons = localStorage.getItem('couponScanner_coupons');
        if (savedCoupons) { coupons = JSON.parse(savedCoupons); }
        renderCouponList(); 
        console.log("Coupons loaded from localStorage.");
    }
    function updateCouponCount() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
        couponCountElement.textContent = `(${coupons.length}개)`; 
        console.log("Coupon count updated to:", coupons.length);
    }
    function getFormattedCouponText() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ 
        if (coupons.length === 0) return "저장된 쿠폰이 없습니다.";
        return "저장된 쿠폰 목록:\n" + coupons.join("\n");
    }
    function copyAllCouponsToClipboard() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ }
    async function shareAllCoupons() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ }
    function exportCouponsAsTextFile() { /* ... 이전 코드와 동일 (최적화된 삭제 로직 유지) ... */ }

    initialize();
});
