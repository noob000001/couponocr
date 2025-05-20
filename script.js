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

    // --- 초기화 함수 (이전과 동일) ---
    async function initialize() {
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
            ocrStatusElement.textContent = '카메라를 준비 중입니다... 권한을 허용해주세요.';
            await setupCamera();
            loadSettings(); loadCoupons(); setupEventListeners(); updateCouponCount();
            ocrStatusElement.textContent = '준비 완료. 쿠폰을 스캔 창에 맞춰주세요.';
        } catch (error) {
            console.error("초기화 중 오류 발생:", error);
            ocrStatusElement.textContent = `오류: ${error.message}. 카메라/OCR 초기화 실패.`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `초기화 오류: ${error.message}`;
            alert(`오류: ${error.message}. 페이지를 새로고침하거나 카메라 권한을 확인해주세요.`);
        }
    }

    // --- 카메라 설정 (이전과 동일) ---
    async function setupCamera() {
        try {
            if (localStream) { localStream.getTracks().forEach(track => track.stop()); }
            const constraints = { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            videoElement.srcObject = localStream;
            await videoElement.play(); 
            captureBtn.disabled = false;
            ocrStatusElement.textContent = '카메라 준비 완료.';
        } catch (err) {
            console.error("카메라 접근 오류:", err);
            ocrStatusElement.textContent = '카메라 접근에 실패했습니다. 권한을 확인해주세요.';
            captureBtn.disabled = true;
            alert('카메라 접근에 실패했습니다. 페이지를 새로고침하고 권한을 허용해주세요.');
        }
    }

    // --- 설정 로드 및 저장 (이전과 동일) ---
    function loadSettings() {
        const savedLength = localStorage.getItem('couponScanner_couponLength');
        if (savedLength) couponLengthInput.value = savedLength;
        const savedFormat = localStorage.getItem('couponScanner_couponFormat');
        if (savedFormat) couponFormatSelect.value = savedFormat;
    }
    function saveSettings() {
        localStorage.setItem('couponScanner_couponLength', couponLengthInput.value);
        localStorage.setItem('couponScanner_couponFormat', couponFormatSelect.value);
    }

    // --- 이벤트 리스너 설정 (이전과 동일) ---
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
                deleteCoupon(event.target.dataset.code);
            }
        });
    }
    
    // === 이미지 잘라내기 로직 수정: object-fit:cover 효과 고려 ===
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

        try {
            const videoIntrinsicWidth = videoElement.videoWidth;
            const videoIntrinsicHeight = videoElement.videoHeight;
            const videoAspectRatio = videoIntrinsicWidth / videoIntrinsicHeight;

            // .scanner-area는 CSS에서 aspect-ratio: 4/3 으로 설정됨 (비디오 컨테이너)
            const scannerArea = document.querySelector('.scanner-area');
            const containerWidth = scannerArea.offsetWidth;
            const containerHeight = scannerArea.offsetHeight; // aspect-ratio에 의해 결정된 높이
            const containerAspectRatio = containerWidth / containerHeight;

            let sWidth, sHeight, sx, sy; // 원본 비디오에서 잘라낼 영역

            // object-fit: cover 효과 계산
            if (videoAspectRatio > containerAspectRatio) { 
                // 비디오가 컨테이너보다 넓다 -> 비디오의 높이를 컨테이너 높이에 맞추고, 너비는 잘린다.
                sHeight = videoIntrinsicHeight;
                sWidth = sHeight * containerAspectRatio;
                sx = (videoIntrinsicWidth - sWidth) / 2;
                sy = 0;
            } else { 
                // 비디오가 컨테이너보다 길거나 비율이 같다 -> 비디오의 너비를 컨테이너 너비에 맞추고, 높이는 잘린다.
                sWidth = videoIntrinsicWidth;
                sHeight = sWidth / containerAspectRatio;
                sx = 0;
                sy = (videoIntrinsicHeight - sHeight) / 2;
            }
            
            // 이제 sx, sy, sWidth, sHeight는 원본 비디오에서 "컨테이너에 cover"된 부분이다.
            // 이 "cover된 부분"을 기준으로 스캔 창의 상대적 위치/크기를 다시 계산한다.

            const scanWindowRect = scanWindow.getBoundingClientRect(); // 스캔창의 화면상 절대 위치/크기
            const scannerAreaRect = scannerArea.getBoundingClientRect(); // scanner-area의 화면상 절대 위치/크기
            
            // scanner-area 내에서 스캔창의 상대적 위치 (비율)
            const scanWindowRelativeX = (scanWindowRect.left - scannerAreaRect.left) / scannerAreaRect.width;
            const scanWindowRelativeY = (scanWindowRect.top - scannerAreaRect.top) / scannerAreaRect.height;
            const scanWindowRelativeWidth = scanWindowRect.width / scannerAreaRect.width;
            const scanWindowRelativeHeight = scanWindowRect.height / scannerAreaRect.height;

            // "cover된 비디오 영역 (sWidth, sHeight)" 에서 스캔 창에 해당하는 부분을 최종적으로 잘라낸다.
            const finalCropX = sx + (sWidth * scanWindowRelativeX);
            const finalCropY = sy + (sHeight * scanWindowRelativeY);
            const finalCropWidth = sWidth * scanWindowRelativeWidth;
            const finalCropHeight = sHeight * scanWindowRelativeHeight;

            if (finalCropWidth <= 0 || finalCropHeight <= 0 || finalCropX < 0 || finalCropY < 0 || 
                (finalCropX + finalCropWidth > videoIntrinsicWidth + 0.5) || // 부동소수점 오차 감안
                (finalCropY + finalCropHeight > videoIntrinsicHeight + 0.5) ) {
                console.error("최종 잘라낼 영역 계산 오류(cover 적용 후):", {finalCropX, finalCropY, finalCropWidth, finalCropHeight});
                throw new Error("스캔 창 영역 계산 오류 (cover).");
            }
            
            captureCanvas.width = finalCropWidth;
            captureCanvas.height = finalCropHeight;
            const context = captureCanvas.getContext('2d');
            context.drawImage(
                videoElement,    
                finalCropX, finalCropY, finalCropWidth, finalCropHeight,
                0, 0, finalCropWidth, finalCropHeight
            );
            
            const imageDataUrl = captureCanvas.toDataURL('image/png');
            ocrStatusElement.textContent = '쿠폰 번호 인식 중... 잠시만 기다려주세요.';
            
            const { data: { text } } = await tesseractScheduler.addJob('recognize', imageDataUrl);
            processOCRResult(text);

        } catch (error) {
            console.error("캡처 또는 OCR 오류:", error);
            ocrStatusElement.textContent = `오류 발생: ${error.message}`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `캡처/OCR 오류: ${error.message}`;
        } finally {
            captureBtn.disabled = false;
        }
    }
    // === 이미지 잘라내기 로직 수정 끝 ===

    // --- OCR 결과 처리 (이전과 동일) ---
    function processOCRResult(rawText) {
        ocrStatusElement.textContent = '인식 완료. 결과 분석 중...';
        console.log("원본 OCR 텍스트:", rawText);
        if (ocrRawDebugOutputElement) { ocrRawDebugOutputElement.textContent = `[OCR 원본]: "${rawText}" (길이: ${rawText ? rawText.length : 0})`; }
        let workingText = rawText ? rawText.replace(/\s+/g, '') : ''; 
        const selectedFormat = couponFormatSelect.value;
        let finalFilteredText = '';
        if (selectedFormat === 'alphanumeric') {
            workingText = workingText.replace(/-/g, ''); 
            finalFilteredText = workingText.replace(/[^A-Za-z0-9]/g, '');
        } else if (selectedFormat === 'alphanumeric_hyphen') {
            finalFilteredText = workingText.replace(/[^A-Za-z0-9\-]/g, '');
        } else { finalFilteredText = workingText.replace(/[^A-Za-z0-9]/g, ''); }
        console.log("선택 형식:", selectedFormat, " | 필터링 후:", finalFilteredText, " | 길이:", finalFilteredText.length);
        const lengthPattern = couponLengthInput.value.trim();
        let minLength = 0, maxLength = Infinity;
        if (lengthPattern.includes('-')) {
            const parts = lengthPattern.split('-');
            minLength = parseInt(parts[0], 10) || 0;
            maxLength = parseInt(parts[1], 10) || Infinity;
        } else if (lengthPattern) {
            minLength = parseInt(lengthPattern, 10) || 0;
            maxLength = minLength; 
        }
        if (finalFilteredText.length >= minLength && finalFilteredText.length <= maxLength && finalFilteredText.length > 0) { 
            currentCandidateCode = finalFilteredText;
            recognizedCodeCandidateElement.textContent = currentCandidateCode;
            addToListBtn.style.display = 'inline-block';
            ocrStatusElement.textContent = '인식된 번호를 확인하고 목록에 추가하세요.';
        } else {
            currentCandidateCode = null;
            recognizedCodeCandidateElement.textContent = '-';
            addToListBtn.style.display = 'none';
            let message = `필터링 후 내용(${finalFilteredText})이 설정된 자릿수(${lengthPattern})와 맞지 않습니다.`;
            if (finalFilteredText.length === 0 && rawText && rawText.trim().length > 0) { message += ` (유효한 문자를 찾지 못함)`; }
            message += ` (OCR 원본은 위 파란색 텍스트 참고)`;
            ocrStatusElement.textContent = message;
        }
    }

    // --- 쿠폰 목록 관리 (이전과 동일) ---
    function addCandidateToList() {
        if (currentCandidateCode && !coupons.includes(currentCandidateCode)) {
            coupons.push(currentCandidateCode); saveCoupons(); renderCouponList(); updateCouponCount();
            ocrStatusElement.textContent = `"${currentCandidateCode}" 가 목록에 추가되었습니다.`;
            recognizedCodeCandidateElement.textContent = ''; addToListBtn.style.display = 'none'; currentCandidateCode = null;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = ''; 
        } else if (coupons.includes(currentCandidateCode)) { ocrStatusElement.textContent = '이미 목록에 있는 번호입니다.';
        } else if (!currentCandidateCode) { ocrStatusElement.textContent = '추가할 유효한 쿠폰 번호가 없습니다.'; }
    }
    function deleteCoupon(codeToDelete) {
        coupons = coupons.filter(code => code !== codeToDelete); saveCoupons(); renderCouponList(); updateCouponCount();
        ocrStatusElement.textContent = `"${codeToDelete}" 가 목록에서 삭제되었습니다.`;
    }
    function deleteAllCoupons() {
        if (coupons.length === 0) { ocrStatusElement.textContent = '삭제할 쿠폰이 없습니다.'; return; }
        if (confirm('정말로 모든 쿠폰 목록을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
            coupons = []; saveCoupons(); renderCouponList(); updateCouponCount();
            ocrStatusElement.textContent = '모든 쿠폰이 삭제되었습니다.';
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        }
    }
    function renderCouponList() {
        couponListULElement.innerHTML = ''; 
        if (coupons.length === 0) {
            const li = document.createElement('li'); li.textContent = '저장된 쿠폰이 없습니다.';
            li.style.textAlign = 'center'; li.style.color = '#7f8c8d';
            couponListULElement.appendChild(li);
        } else {
            coupons.forEach(code => {
                const li = document.createElement('li'); const codeSpan = document.createElement('span');
                codeSpan.textContent = code; li.appendChild(codeSpan);
                const deleteBtn = document.createElement('button'); deleteBtn.textContent = '삭제';
                deleteBtn.classList.add('delete-item-btn'); deleteBtn.dataset.code = code; 
                li.appendChild(deleteBtn); couponListULElement.appendChild(li);
            });
        }
    }
    function saveCoupons() { localStorage.setItem('couponScanner_coupons', JSON.stringify(coupons)); }
    function loadCoupons() {
        const savedCoupons = localStorage.getItem('couponScanner_coupons');
        if (savedCoupons) { coupons = JSON.parse(savedCoupons); }
        renderCouponList();
    }
    function updateCouponCount() { couponCountElement.textContent = `(${coupons.length}개)`; }

    // --- 내보내기/공유 기능 (이전과 동일) ---
    function getFormattedCouponText() {
        if (coupons.length === 0) return "저장된 쿠폰이 없습니다.";
        return "저장된 쿠폰 목록:\n" + coupons.join("\n");
    }
    function copyAllCouponsToClipboard() {
        if (coupons.length === 0) { alert('복사할 쿠폰이 없습니다.'); return; }
        const textToCopy = getFormattedCouponText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy)
                .then(() => { alert('쿠폰 목록이 클립보드에 복사되었습니다.'); ocrStatusElement.textContent = '쿠폰 목록 클립보드 복사됨.'; })
                .catch(err => { console.error('클립보드 복사 실패:', err); alert('클립보드 복사에 실패했습니다.'); });
        } else { alert('클립보드 기능이 지원되지 않습니다.'); prompt("아래 내용을 직접 복사하세요:", textToCopy); }
    }
    async function shareAllCoupons() {
        if (coupons.length === 0) { alert('공유할 쿠폰이 없습니다.'); return; }
        const shareData = { title: '내 쿠폰 목록', text: getFormattedCouponText() };
        if (navigator.share) {
            try { await navigator.share(shareData); ocrStatusElement.textContent = '쿠폰 목록 공유 시도 완료.'; }
            catch (err) { console.error('공유 실패:', err); if (err.name !== 'AbortError') { ocrStatusElement.textContent = `공유 실패: ${err.message}`; alert(`공유 실패: ${err.message}`); } }
        } else { alert('웹 공유 기능이 지원되지 않습니다.'); ocrStatusElement.textContent = '웹 공유 기능 미지원.'; }
    }
    function exportCouponsAsTextFile() {
        if (coupons.length === 0) { alert('내보낼 쿠폰이 없습니다.'); return; }
        const textContent = getFormattedCouponText();
        const filename = `coupons_${new Date().toISOString().slice(0,10)}.txt`;
        const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename;
        document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(link.href); 
        ocrStatusElement.textContent = `${filename} 파일 다운로드됨.`;
    }

    // --- 앱 시작 ---
    initialize();
});
