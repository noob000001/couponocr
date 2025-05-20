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
            const videoIntrinsicHeight = videoElement.videoHeight;

            const scaleX = videoIntrinsicWidth / videoRenderedWidth;
            const scaleY = videoIntrinsicHeight / videoRenderedHeight;

            // 스캔 창 요소의 화면상 위치와 크기 (딤처리된 배경 기준)
            const overlayRect = scanWindowOverlay.getBoundingClientRect();
            const scanWindowRect = scanWindow.getBoundingClientRect();

            // 딤처리된 배경(.scan-window-overlay) 내부에서 스캔 창의 상대적 위치와 크기를 계산
            // 이 값들은 렌더링된 비디오 크기에 대한 비율로 변환되어야 함
            const cropVisualX = scanWindowRect.left - overlayRect.left;
            const cropVisualY = scanWindowRect.top - overlayRect.top;
            const cropVisualWidth = scanWindowRect.width;
            const cropVisualHeight = scanWindowRect.height;
            
            // 실제 비디오 프레임에서 잘라낼 영역 계산 (스케일링 적용)
            const finalCropX = cropVisualX * scaleX;
            const finalCropY = cropVisualY * scaleY;
            const finalCropWidth = cropVisualWidth * scaleX;
            const finalCropHeight = cropVisualHeight * scaleY;

            if (finalCropWidth <= 0 || finalCropHeight <= 0 || finalCropX < 0 || finalCropY < 0 || (finalCropX + finalCropWidth > videoIntrinsicWidth) || (finalCropY + finalCropHeight > videoIntrinsicHeight)) {
                console.error("잘라낼 영역 계산 오류:", {finalCropX, finalCropY, finalCropWidth, finalCropHeight, videoIntrinsicWidth, videoIntrinsicHeight});
                throw new Error("스캔 창 영역 계산 오류. 페이지를 새로고침하거나 카메라를 확인하세요.");
            }
            
            captureCanvas.width = finalCropWidth;
            captureCanvas.height = finalCropHeight;
            const context = captureCanvas.getContext('2d');
            // 비디오의 특정 영역(스캔 창에 해당하는)을 캔버스에 그림
            context.drawImage(
                videoElement,    // 원본 비디오
                finalCropX,      // 원본 비디오에서 자르기 시작할 X 좌표
                finalCropY,      // 원본 비디오에서 자르기 시작할 Y 좌표
                finalCropWidth,  // 원본 비디오에서 자를 너비
                finalCropHeight, // 원본 비디오에서 자를 높이
                0,               // 캔버스에 그리기 시작할 X 좌표
                0,               // 캔버스에 그리기 시작할 Y 좌표
                finalCropWidth,  // 캔버스에 그릴 너비 (잘라낸 너비와 동일)
                finalCropHeight  // 캔버스에 그릴 높이 (잘라낸 높이와 동일)
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

    // --- OCR 결과 처리 (쿠폰 형식 조건부 로직 추가) ---
    function processOCRResult(rawText) {
        ocrStatusElement.textContent = '인식 완료. 결과 분석 중...';
        console.log("원본 OCR 텍스트:", rawText);

        if (ocrRawDebugOutputElement) {
            ocrRawDebugOutputElement.textContent = `[OCR 원본]: "${rawText}" (길이: ${rawText ? rawText.length : 0})`;
        }

        let workingText = rawText ? rawText.replace(/\s+/g, '') : ''; // 1차: 공백만 제거
        const selectedFormat = couponFormatSelect.value;
        let finalFilteredText = '';

        if (selectedFormat === 'alphanumeric') {
            // 영문/숫자 모드: 하이픈 제거 후 영숫자만 남김
            workingText = workingText.replace(/-/g, ''); 
            finalFilteredText = workingText.replace(/[^A-Za-z0-9]/g, '');
        } else if (selectedFormat === 'alphanumeric_hyphen') {
            // 영문/숫자 + 하이픈 포함 모드: 영숫자와 하이픈만 남김 (하이픈은 유지)
            finalFilteredText = workingText.replace(/[^A-Za-z0-9\-]/g, '');
        } else { // 기본값 (혹시 모를 상황 대비)
            finalFilteredText = workingText.replace(/[^A-Za-z0-9]/g, '');
        }
        
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

        if (finalFilteredText.length >= minLength && finalFilteredText.length <= maxLength && finalFilteredText.length > 0) { // 길이가 0인 경우도 제외
            currentCandidateCode = finalFilteredText;
            recognizedCodeCandidateElement.textContent = currentCandidateCode;
            addToListBtn.style.display = 'inline-block';
            ocrStatusElement.textContent = '인식된 번호를 확인하고 목록에 추가하세요.';
        } else {
            currentCandidateCode = null;
            recognizedCodeCandidateElement.textContent = '-';
            addToListBtn.style.display = 'none';
            let message = `필터링 후 내용(${finalFilteredText})이 설정된 자릿수(${lengthPattern})와 맞지 않습니다.`;
            if (finalFilteredText.length === 0 && rawText && rawText.trim().length > 0) {
                message += ` (유효한 문자를 찾지 못함)`;
            }
            message += ` (OCR 원본은 위 파란색 텍스트 참고)`;
            ocrStatusElement.textContent = message;
        }
    }

    // --- 쿠폰 목록 관리 ---
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
             if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = ''; 
        } else if (coupons.includes(currentCandidateCode)) {
            ocrStatusElement.textContent = '이미 목록에 있는 번호입니다.';
        } else if (!currentCandidateCode) {
             ocrStatusElement.textContent = '추가할 유효한 쿠폰 번호가 없습니다.';
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
        if (coupons.length === 0) {
             ocrStatusElement.textContent = '삭제할 쿠폰이 없습니다.';
            return;
        }
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

    // --- 내보내기/공유 기능 ---
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
                await navigator.share(shareData);
                ocrStatusElement.textContent = '쿠폰 목록 공유 시도 완료.';
            } catch (err) {
                console.error('공유 실패:', err);
                if (err.name !== 'AbortError') {
                     ocrStatusElement.textContent = `공유 실패: ${err.message}`;
                     alert(`공유에 실패했습니다: ${err.message}`);
                }
            }
        } else {
            alert('웹 공유 기능이 지원되지 않는 브라우저입니다. 클립보드 복사 후 직접 공유해주세요.');
            ocrStatusElement.textContent = '웹 공유 기능이 지원되지 않습니다.';
        }
    }

    function exportCouponsAsTextFile() {
        if (coupons.length === 0) {
            alert('내보낼 쿠폰이 없습니다.');
            return;
        }
        const textContent = getFormattedCouponText();
        const filename = `coupons_${new Date().toISOString().slice(0,10)}.txt`;
        const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href); 
        ocrStatusElement.textContent = `${filename} 파일이 다운로드되었습니다.`;
    }

    // --- 앱 시작 ---
    initialize();
});
