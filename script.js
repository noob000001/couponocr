document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 요소 가져오기 ---
    const videoElement = document.getElementById('camera-feed');
    const captureCanvas = document.getElementById('capture-canvas');
    const scanWindowOverlay = document.querySelector('.scan-window-overlay'); // 스캔 창의 부모 (딤처리 배경)
    const scanWindow = document.querySelector('.scan-window'); // 실제 스캔 창 (테두리)

    const couponLengthInput = document.getElementById('coupon-length');
    const couponFormatSelect = document.getElementById('coupon-format'); // 새로 추가된 쿠폰 형식 선택
    // const recognitionModeSelect = document.getElementById('recognition-mode'); // 현재 사용 안함
    
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

    // --- 전역 변수 및 상태 ---
    let localStream = null;
    let tesseractScheduler = null; 
    let tesseractWorkersCount = 1; // 워커 수 (모바일 환경 고려하여 1로 시작, 필요시 조절)
    let coupons = []; 
    let currentCandidateCode = null;
    // Tesseract.js 기본 화이트리스트 (영숫자 + 하이픈) - 이 설정으로 워커 생성 후 JS로 추가 필터링
    const TESS_WHITELIST = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-';


    // --- 초기화 함수 ---
    async function initialize() {
        ocrStatusElement.textContent = 'OCR 엔진을 로드 중입니다...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        try {
            tesseractScheduler = Tesseract.createScheduler();
            const workerPromises = [];
            for (let i = 0; i < tesseractWorkersCount; i++) {
                // 화이트리스트는 워커 생성 시점에 설정하거나, 각 작업마다 setParameters로 변경 가능
                // 여기서는 생성 시점에 광범위한 화이트리스트를 설정하고 JS로 필터링
                const worker = await Tesseract.createWorker('kor+eng', 1, { /* logger: m => console.log(m) */ });
                await worker.setParameters({
                    tessedit_char_whitelist: TESS_WHITELIST,
                });
                tesseractScheduler.addWorker(worker);
                workerPromises.push(Promise.resolve()); // 더미 프로미스 (실제론 워커 추가 성공 여부)
            }
            await Promise.all(workerPromises);
            
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
            await videoElement.play(); // 명시적 재생 호출
            captureBtn.disabled = false;
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
        
        const savedFormat = localStorage.getItem('couponScanner_couponFormat');
        if (savedFormat) couponFormatSelect.value = savedFormat;
    }
    function saveSettings() {
        localStorage.setItem('couponScanner_couponLength', couponLengthInput.value);
        localStorage.setItem('couponScanner_couponFormat', couponFormatSelect.value);
    }

    // --- 이벤트 리스너 설정 ---
    function setupEventListeners() {
        captureBtn.addEventListener('click', handleManualCapture);
        addToListBtn.addEventListener('click', addCandidateToList);
        
        couponLengthInput.addEventListener('change', saveSettings);
        couponFormatSelect.addEventListener('change', saveSettings); // 형식 변경 시 저장

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

    // --- 수동 캡처 처리 (ROI 처리 수정) ---
    async function handleManualCapture() {
        if (!localStream || !videoElement.srcObject || videoElement.readyState < videoElement.HAVE_METADATA) {
            ocrStatusElement.textContent = '카메라가 준비되지 않았습니다. 잠시 후 다시 시도해주세요.';
            return;
        }
        if (!tesseractScheduler || tesseractScheduler.getNumWorkers() === 0) {
            ocrStatusElement.textContent = 'OCR 엔진이 준비되지 않았습니다. 페이지를 새로고침 해주세요.';
            console.warn("OCR 스케줄러 또는 워커 문제");
            return;
        }
        
        captureBtn.disabled = true;
        addToListBtn.style.display = 'none';
        recognizedCodeCandidateElement.textContent = '';
        ocrStatusElement.textContent = '이미지 캡처 중...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';

        try {
            // 비디오 요소의 실제 렌더링된 크기와 비디오 원본 크기 비율 계산
            const videoRenderedWidth = videoElement.offsetWidth;
            const videoRenderedHeight = videoElement.offsetHeight;
            const videoIntrinsicWidth = videoElement.videoWidth;
            const video
