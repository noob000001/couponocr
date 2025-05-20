document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 요소 가져오기 (이전과 동일) ---
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

    // --- 전역 변수 및 상태 (이전과 동일) ---
    let localStream = null;
    let tesseractScheduler = null; 
    let tesseractWorkersCount = 1; 
    let coupons = []; 
    let currentCandidateCode = null;
    const TESS_WHITELIST = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-';

    // --- 초기화 함수 (이전과 동일, 내부 console.log 유지) ---
    async function initialize() {
        console.log("App initializing...");
        ocrStatusElement.textContent = 'OCR 엔진을 로드 중입니다...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        try {
            tesseractScheduler = Tesseract.createScheduler();
            const workerPromises = [];
            for (let i = 0; i < tesseractWorkersCount; i++) {
                const worker = await Tesseract.createWorker('kor+eng', 1, { /* logger: m => console.log(m) */ });
                await worker.setParameters({ tessedit_char_whitelist: TESS_WHITELIST });
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

    // --- 카메라 설정 (이전과 동일) ---
    async function setupCamera() { /* ... 이전 코드와 동일 ... */ 
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

    // --- 설정 로드 및 저장 (이전과 동일) ---
    function loadSettings() { /* ... 이전 코드와 동일 ... */ 
        const savedLength = localStorage.getItem('couponScanner_couponLength');
        if (savedLength) couponLengthInput.value = savedLength;
        const savedFormat = localStorage.getItem('couponScanner_couponFormat');
        if (savedFormat) couponFormatSelect.value = savedFormat;
        console.log("Settings loaded.");
    }
    function saveSettings() { /* ... 이전 코드와 동일 ... */ 
        localStorage.setItem('couponScanner_couponLength', couponLengthInput.value);
        localStorage.setItem('couponScanner_couponFormat', couponFormatSelect.value);
        console.log("Settings saved.");
    }

    // --- 이벤트 리스너 설정 (삭제 버튼 클릭 시 listItem 전달하도록 수정) ---
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
            console.log("Click event on coupon list UL.", event.target);
            if (event.target && event.target.classList.contains('delete-item-btn')) {
                const codeToDelete = event.target.dataset.code;
                const listItemElement = event.target.closest('li'); // 삭제할 li 요소를 찾음
                console.log("Delete button clicked for code:", codeToDelete);
                deleteCoupon(codeToDelete, listItemElement); // li 요소도 함께 전달
            }
        });
        console.log("Event listeners setup.");
    }
    
    // --- 이미지 잘라내기 로직 (이전 버전과 동일) ---
    async function handleManualCapture() { /* ... 이전 코드와 동일 ... */ 
        if (!localStream || !videoElement.srcObject || videoElement.readyState < videoElement.HAVE_METADATA) {
            ocrStatusElement.textContent = '카메라가 준비되지 않았습니다.'; return;
        }
        if (!tesseractScheduler || tesseractScheduler.getNumWorkers() === 0) { 
            ocrStatusElement.textContent = 'OCR 엔진 준비 중...'; return;
        }
        captureBtn.disabled = true; addToListBtn.style.display = 'none'; recognizedCodeCandidateElement.textContent = '';
        ocrStatusElement.textContent = '이미지 캡처 중...'; if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        try {
            const renderedVideo = getContainedVideoDimensions(videoElement);
            const videoIntrinsicWidth = videoElement.videoWidth; const videoIntrinsicHeight = videoElement.videoHeight;
            const videoElemRect = videoElement.getBoundingClientRect(); const scanWindowRect = scanWindow.getBoundingClientRect();
            const scanX_relative_to_video_content_start = (scanWindowRect.left - videoElemRect.left - renderedVideo.x) / renderedVideo.width;
            const scanY_relative_to_video_content_start = (scanWindowRect.top - videoElemRect.top - renderedVideo.y) / renderedVideo.height;
            const scanWidth_relative_to_video_content = scanWindowRect.width / renderedVideo.width;
            const scanHeight_relative_to_video_content = scanWindowRect.height / renderedVideo.height;
            const sx = videoIntrinsicWidth * scanX_relative_to_video_content_start;
            const sy = videoIntrinsicHeight * scanY_relative_to_video_content_start;
            const sWidth = videoIntrinsicWidth * scanWidth_relative_to_video_content;
            const sHeight = videoIntrinsicHeight * scanHeight_relative_to_video_content;
            if (sWidth <= 0 || sHeight <= 0 || sx < 0 || sy < 0 || (sx + sWidth > videoIntrinsicWidth + 0.5) || (sy + sHeight > videoIntrinsicHeight + 0.5) ) {
                console.error("최종 잘라낼 영역 계산 오류 또는 스캔창이 비디오 영역 바깥에 위치:", {sx, sy, sWidth, sHeight, videoIntrinsicWidth, videoIntrinsicHeight});
                throw new Error("스캔 창 영역 계산 오류. 스캔 창 크기나 위치를 확인하세요.");
            }
            captureCanvas.width = sWidth; captureCanvas.height = sHeight;
            const context = captureCanvas.getContext('2d');
            context.drawImage(videoElement, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);
            const imageDataUrl = captureCanvas.toDataURL('image/png');
            ocrStatusElement.textContent = '쿠폰 번호 인식 중... 잠시만 기다려주세요.';
            const { data: { text } } = await tesseractScheduler.addJob('recognize', imageDataUrl);
            processOCRResult(text);
        } catch (error) {
            console.error("캡처 또는 OCR 오류:", error); ocrStatusElement.textContent = `오류 발생: ${error.message}`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `캡처/OCR 오류: ${error.message}`;
        } finally { captureBtn.disabled = false; }
    }
    
    function getContainedVideoDimensions(videoElement) { /* ... 이전 코드와 동일 ... */ 
        const videoIntrinsicWidth = videoElement.videoWidth; const videoIntrinsicHeight = videoElement.videoHeight;
        const videoElemClientWidth = videoElement.clientWidth; const videoElemClientHeight = videoElement.clientHeight; 
        const videoAspectRatio = videoIntrinsicWidth / videoIntrinsicHeight; const elemAspectRatio = videoElemClientWidth / videoElemClientHeight;
        let renderWidth, renderHeight, xOffset, yOffset;
        if (videoAspectRatio > elemAspectRatio) { 
            renderWidth = videoElemClientWidth; renderHeight = videoElemClientWidth / videoAspectRatio;
            xOffset = 0; yOffset = (videoElemClientHeight - renderHeight) / 2;
        } else { 
            renderHeight = videoElemClientHeight; renderWidth = videoElemClientHeight * videoAspectRatio;
            yOffset = 0; xOffset = (videoElemClientWidth - renderWidth) / 2;
        }
        return { x: xOffset, y: yOffset, width: renderWidth, height: renderHeight };
    }

    // --- OCR 결과 처리 (이전과 동일) ---
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

    // --- 쿠폰 목록 관리 (deleteCoupon 및 renderCouponList 수정) ---
    function addCandidateToList() { /* ... 이전 코드와 동일, 내부 console.log 유지 ... */ 
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

    // === deleteCoupon 함수 수정: 특정 li 요소 직접 삭제 ===
    function deleteCoupon(codeToDelete, listItemElement) { // listItemElement 인자 추가
        console.log("--- deleteCoupon initiated ---");
        console.log("Attempting to delete code:", codeToDelete, "| Type:", typeof codeToDelete);
        console.log("Coupons array BEFORE deletion:", JSON.parse(JSON.stringify(coupons)));

        const initialLength = coupons.length;
        coupons = coupons.filter(code => code !== codeToDelete);
        const newLength = coupons.length;
        
        console.log("Coupons array AFTER deletion:", JSON.parse(JSON.stringify(coupons)));

        if (initialLength !== newLength) { // 실제로 배열에서 항목이 삭제되었는지 확인
            console.log("Code was found and removed from array. Now calling saveCoupons...");
            saveCoupons();

            if (listItemElement && listItemElement.parentNode === couponListULElement) {
                console.log("Attempting to remove specific li element from DOM:", listItemElement);
                couponListULElement.removeChild(listItemElement);
                console.log("Specific li element removed from DOM.");
            } else {
                // listItemElement가 없거나 유효하지 않은 경우, 전체 목록 다시 그림 (deleteAllCoupons 등에서 호출될 수 있음)
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

    function deleteAllCoupons() {
        console.log("--- deleteAllCoupons initiated ---");
        if (coupons.length === 0) { ocrStatusElement.textContent = '삭제할 쿠폰이 없습니다.'; return; }
        if (confirm('정말로 모든 쿠폰 목록을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
            coupons = []; 
            saveCoupons(); 
            renderCouponList(); // 전체 삭제 시에는 전체 목록 다시 그림
            updateCouponCount();
            ocrStatusElement.textContent = '모든 쿠폰이 삭제되었습니다.';
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
            console.log("All coupons deleted.");
        }
        console.log("--- deleteAllCoupons finished ---");
    }

    // === renderCouponList 함수 수정: li 요소에 data-code-li 속성 추가 (선택적) ===
    function renderCouponList() {
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
                // console.log(`Rendering item ${index + 1}: ${code}`); // 필요시 주석 해제
                const li = document.createElement('li'); 
                // li.setAttribute('data-code-li', code); // 특정 li를 DOM에서 찾기 위한 식별자 (필요하다면)
                const codeSpan = document.createElement('span');
                codeSpan.textContent = code; 
                li.appendChild(codeSpan);

                const deleteBtn = document.createElement('button'); 
                deleteBtn.textContent = '삭제';
                deleteBtn.classList.add('delete-item-btn'); 
                deleteBtn.dataset.code = code; // 삭제할 코드를 data 속성에 저장
                li.appendChild(deleteBtn); 
                
                couponListULElement.appendChild(li);
            });
            console.log("All coupon items rendered.");
        }
        console.log("--- renderCouponList finished ---");
    }

    function saveCoupons() { /* ... 이전 코드와 동일, 내부 console.log 유지 ... */ 
        localStorage.setItem('couponScanner_coupons', JSON.stringify(coupons)); 
        console.log("Coupons saved to localStorage.");
    }
    function loadCoupons() { /* ... 이전 코드와 동일, 내부 console.log 유지 ... */ 
        const savedCoupons = localStorage.getItem('couponScanner_coupons');
        if (savedCoupons) { coupons = JSON.parse(savedCoupons); }
        renderCouponList(); 
        console.log("Coupons loaded from localStorage.");
    }
    function updateCouponCount() { /* ... 이전 코드와 동일, 내부 console.log 유지 ... */ 
        couponCountElement.textContent = `(${coupons.length}개)`; 
        console.log("Coupon count updated to:", coupons.length);
    }

    // --- 내보내기/공유 기능 (이전과 동일) ---
    function getFormattedCouponText() { /* ... */ return "저장된 쿠폰 목록:\n" + coupons.join("\n"); }
    function copyAllCouponsToClipboard() { /* ... */ }
    async function shareAllCoupons() { /* ... */ }
    function exportCouponsAsTextFile() { /* ... */ }

    // --- 앱 시작 ---
    initialize();
});
