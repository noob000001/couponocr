document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 요소 가져오기 ---
    const videoElement = document.getElementById('camera-feed');
    const captureCanvas = document.getElementById('capture-canvas');
    const scanWindow = document.querySelector('.scan-window'); 

    const couponLengthInput = document.getElementById('coupon-length');
    const recognitionModeSelect = document.getElementById('recognition-mode');
    
    const captureBtn = document.getElementById('capture-btn');
    // const autoCaptureToggleBtn = document.getElementById('auto-capture-toggle-btn'); // 자동 인식은 아직 구현 안됨

    const ocrStatusElement = document.getElementById('ocr-status');
    const ocrRawDebugOutputElement = document.getElementById('ocr-raw-debug-output'); // 디버그용 요소
    const recognizedCodeCandidateElement = document.getElementById('recognized-code-candidate');
    const addToListBtn = document.getElementById('add-to-list-btn');

    const couponListULElement = document.getElementById('coupon-list');
    const couponCountElement = document.getElementById('coupon-count');

    const copyAllBtn = document.getElementById('copy-all-btn');
    const shareAllBtn = document.getElementById('share-all-btn');
    const exportTxtBtn = document.getElementById('export-txt-btn');
    const deleteAllBtn = document.getElementById('delete-all-btn');

    // --- 전역 변수 및 상태 ---
    let localStream = null;
    let tesseractScheduler = null; 
    let tesseractWorkersCount = 2; 
    let coupons = []; 
    let currentCandidateCode = null; 

    // --- 초기화 함수 ---
    async function initialize() {
        ocrStatusElement.textContent = 'OCR 엔진을 로드 중입니다...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = ''; // 디버그 메시지 초기화
        try {
            tesseractScheduler = Tesseract.createScheduler();
            const workerPromises = [];
            for (let i = 0; i < tesseractWorkersCount; i++) {
                workerPromises.push(
                    Tesseract.createWorker('kor+eng', 1, { /* logger: m => console.log(m) */ })
                    .then(worker => tesseractScheduler.addWorker(worker))
                );
            }
            await Promise.all(workerPromises); // 모든 워커가 추가될 때까지 기다림
            
            ocrStatusElement.textContent = '카메라를 준비 중입니다... 권한을 허용해주세요.';
            await setupCamera();
            loadSettings();
            loadCoupons();
            setupEventListeners();
            updateCouponCount();
            ocrStatusElement.textContent = '준비 완료. 쿠폰을 스캔 창에 맞춰주세요.';
        } catch (error) {
            console.error("초기화 중 오류 발생:", error);
            ocrStatusElement.textContent = `오류: ${error.message}. 카메라/OCR 초기화 실패.`;
            if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = `초기화 오류: ${error.message}`;
            alert(`오류: ${error.message}. 페이지를 새로고침하거나 카메라 권한을 확인해주세요.`);
        }
    }

    // --- 카메라 설정 ---
    async function setupCamera() {
        try {
            if (localStream) { 
                localStream.getTracks().forEach(track => track.stop());
            }
            const constraints = {
                video: {
                    facingMode: 'environment', 
                    width: { ideal: 1280 }, 
                    height: { ideal: 720 }
                },
                audio: false
            };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            videoElement.srcObject = localStream;
            videoElement.onloadedmetadata = () => {
                captureBtn.disabled = false;
            };
            ocrStatusElement.textContent = '카메라 준비 완료.';
        } catch (err) {
            console.error("카메라 접근 오류:", err);
            ocrStatusElement.textContent = '카메라 접근에 실패했습니다. 권한을 확인해주세요.';
            captureBtn.disabled = true;
            alert('카메라 접근에 실패했습니다. 페이지를 새로고침하고 권한을 허용해주세요.');
        }
    }

    // --- 설정 로드 및 저장 ---
    function loadSettings() {
        const savedLength = localStorage.getItem('couponScanner_couponLength');
        if (savedLength) couponLengthInput.value = savedLength;
    }
    function saveSettings() {
        localStorage.setItem('couponScanner_couponLength', couponLengthInput.value);
    }

    // --- 이벤트 리스너 설정 ---
    function setupEventListeners() {
        captureBtn.addEventListener('click', handleManualCapture);
        addToListBtn.addEventListener('click', addCandidateToList);
        
        couponLengthInput.addEventListener('change', saveSettings);

        copyAllBtn.addEventListener('click', copyAllCouponsToClipboard);
        shareAllBtn.addEventListener('click', shareAllCoupons);
        exportTxtBtn.addEventListener('click', exportCouponsAsTextFile);
        deleteAllBtn.addEventListener('click', deleteAllCoupons);

        couponListULElement.addEventListener('click', function(event) {
            if (event.target && event.target.classList.contains('delete-item-btn')) {
                const codeToDelete = event.target.dataset.code;
                deleteCoupon(codeToDelete);
            }
        });
    }

    // --- 수동 캡처 처리 ---
    async function handleManualCapture() {
        if (!localStream || !tesseractScheduler || tesseractScheduler.getQueueLen() === 0) { // 워커가 제대로 추가되었는지 확인
            ocrStatusElement.textContent = '카메라 또는 OCR 엔진이 준비되지 않았습니다. 잠시 후 다시 시도해주세요.';
            console.warn("OCR 스케줄러 또는 워커 문제");
            return;
        }
        
        captureBtn.disabled = true;
        addToListBtn.style.display = 'none';
        recognizedCodeCandidateElement.textContent = '';
        ocrStatusElement.textContent = '이미지 캡처 중...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';


        try {
            const videoRect = videoElement.getBoundingClientRect();
            const scanWindowRect = scanWindow.getBoundingClientRect(); 
            
            const scaleX = videoElement.videoWidth / videoRect.width;
            const scaleY = videoElement.videoHeight / videoRect.height;

            const cropX = Math.max(0, (scanWindowRect.left - videoRect.left) * scaleX);
            const cropY = Math.max(0, (scanWindowRect.top - videoRect.top) * scaleY);
            const cropWidth = Math.min(videoElement.videoWidth - cropX, scanWindowRect.width * scaleX);
            const cropHeight = Math.min(videoElement.videoHeight - cropY, scanWindowRect.height * scaleY);
            
            if (cropWidth <= 0 || cropHeight <= 0) {
                throw new Error("스캔 창 영역 계산 오류. 비디오 크기를 확인하세요.");
            }

            captureCanvas.width = cropWidth;
            captureCanvas.height = cropHeight;
            const context = captureCanvas.getContext('2d');
            context.drawImage(videoElement, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
            
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

    // --- OCR 결과 처리 (디버그 메시지 추가) ---
    function processOCRResult(rawText) {
        ocrStatusElement.textContent = '인식 완료. 결과 분석 중...';
        console.log("원본 OCR 텍스트:", rawText);

        // === OCR 원본 텍스트 및 길이 화면에 표시 (디버깅용) ===
        if (ocrRawDebugOutputElement) {
            ocrRawDebugOutputElement.textContent = `[OCR 원본]: "${rawText}" (길이: ${rawText ? rawText.length : 0})`;
        }
        // === 디버깅용 코드 끝 ===

        let processedText = rawText ? rawText.replace(/-/g, '').replace(/\s+/g, '') : '';
        
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

        const alphanumericText = processedText.replace(/[^A-Za-z0-9]/g, ''); 
        console.log("영숫자 필터링 후:", alphanumericText, "길이:", alphanumericText.length);

        if (alphanumericText.length >= minLength && alphanumericText.length <= maxLength) {
            currentCandidateCode = alphanumericText;
            recognizedCodeCandidateElement.textContent = currentCandidateCode;
            addToListBtn.style.display = 'inline-block';
            ocrStatusElement.textContent = '인식된 번호를 확인하고 목록에 추가하세요.';
        } else {
            currentCandidateCode = null;
            recognizedCodeCandidateElement.textContent = '-';
            addToListBtn.style.display = 'none';
            // === 메시지 수정: OCR 원본 참고 안내 ===
            ocrStatusElement.textContent = `필터링 후 내용(${alphanumericText})이 설정된 자릿수(${lengthPattern})와 맞지 않습니다. (OCR 원본은 위 파란색 텍스트 참고)`;
            if (!alphanumericText && rawText && rawText.trim()) {
                 ocrStatusElement.textContent += ` (원본에 글자는 있었으나 유효하지 않음)`;
            }
            // === 메시지 수정 끝 ===
        }
    }

    // --- 쿠폰 목록 관리 (이하 동일) ---
    function addCandidateToList() {
        if (currentCandidateCode && !coupons.includes(currentCandidateCode)) {
            coupons.push(currentCandidateCode);
            saveCoupons();
            renderCouponList();
            updateCouponCount();
            ocrStatusElement.textContent = `"${currentCandidateCode}" 가 목록에 추가되었습니다.`;
            recognizedCodeCandidateElement.textContent = '';
            addToListBtn.style.display = 'none';
            currentCandidateCode = null;
             if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = ''; // 성공 시 디버그 메시지 초기화
        } else if (coupons.includes(currentCandidateCode)) {
            ocrStatusElement.textContent = '이미 목록에 있는 번호입니다.';
        }
    }

    function deleteCoupon(codeToDelete) {
        coupons = coupons.filter(code => code !== codeToDelete);
        saveCoupons();
        renderCouponList();
        updateCouponCount();
        ocrStatusElement.textContent = `"${codeToDelete}" 가 목록에서 삭제되었습니다.`;
    }

    function deleteAllCoupons() {
        if (confirm('정말로 모든 쿠폰 목록을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
            coupons = [];
            saveCoupons();
            renderCouponList();
            updateCouponCount();
            ocrStatusElement.textContent = '모든 쿠폰이 삭제되었습니다.';
             if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        }
    }

    function renderCouponList() {
        couponListULElement.innerHTML = ''; 
        if (coupons.length === 0) {
            const li = document.createElement('li');
            li.textContent = '저장된 쿠폰이 없습니다.';
            li.style.textAlign = 'center';
            li.style.color = '#7f8c8d';
            couponListULElement.appendChild(li);
        } else {
            coupons.forEach(code => {
                const li = document.createElement('li');
                const codeSpan = document.createElement('span');
                codeSpan.textContent = code;
                li.appendChild(codeSpan);

                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '삭제';
                deleteBtn.classList.add('delete-item-btn');
                deleteBtn.dataset.code = code; 
                li.appendChild(deleteBtn);
                
                couponListULElement.appendChild(li);
            });
        }
    }

    function saveCoupons() {
        localStorage.setItem('couponScanner_coupons', JSON.stringify(coupons));
    }

    function loadCoupons() {
        const savedCoupons = localStorage.getItem('couponScanner_coupons');
        if (savedCoupons) {
            coupons = JSON.parse(savedCoupons);
        }
        renderCouponList();
    }
    
    function updateCouponCount() {
        couponCountElement.textContent = `(${coupons.length}개)`;
    }

    // --- 내보내기/공유 기능 (이하 동일) ---
    function getFormattedCouponText() {
        if (coupons.length === 0) return "저장된 쿠폰이 없습니다.";
        return "저장된 쿠폰 목록:\n" + coupons.join("\n");
    }

    function copyAllCouponsToClipboard() {
        if (coupons.length === 0) {
            alert('복사할 쿠폰이 없습니다.');
            return;
        }
        const textToCopy = getFormattedCouponText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy)
                .then(() => {
                    alert('쿠폰 목록이 클립보드에 복사되었습니다.');
                    ocrStatusElement.textContent = '쿠폰 목록이 클립보드에 복사되었습니다.';
                })
                .catch(err => {
                    console.error('클립보드 복사 실패:', err);
                    alert('클립보드 복사에 실패했습니다.');
                });
        } else {
            alert('클립보드 복사 기능이 지원되지 않는 환경입니다. 수동으로 복사해주세요.');
            prompt("클립보드 복사가 지원되지 않습니다. 아래 내용을 직접 복사하세요:", textToCopy);
        }
    }

    async function shareAllCoupons() {
        if (coupons.length === 0) {
            alert('공유할 쿠폰이 없습니다.');
            return;
        }
        const shareData = {
            title: '내 쿠폰 목록',
            text: getFormattedCouponText(),
        };
        if (navigator.share) {
            try {
                await navigator.share(shareData
