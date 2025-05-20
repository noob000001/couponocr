document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 요소 가져오기 ---
    const videoElement = document.getElementById('camera-feed');
    const captureCanvas = document.getElementById('capture-canvas');
    const scanWindow = document.querySelector('.scan-window'); // 스캔 창 요소

    const couponLengthInput = document.getElementById('coupon-length');
    const recognitionModeSelect = document.getElementById('recognition-mode');
    
    const captureBtn = document.getElementById('capture-btn');
    const autoCaptureToggleBtn = document.getElementById('auto-capture-toggle-btn'); // 자동 인식은 아직 구현 안됨

    const ocrStatusElement = document.getElementById('ocr-status');
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
    let tesseractScheduler = null; // Tesseract 스케줄러
    let tesseractWorkersCount = 2; // 동시에 실행할 워커 수 (성능에 따라 조절)
    let coupons = []; // 저장된 쿠폰 목록
    let currentCandidateCode = null; // 현재 인식된 후보 코드

    // --- 초기화 함수 ---
    async function initialize() {
        ocrStatusElement.textContent = 'OCR 엔진을 로드 중입니다...';
        try {
            // Tesseract 스케줄러 생성 및 워커 추가
            tesseractScheduler = Tesseract.createScheduler();
            for (let i = 0; i < tesseractWorkersCount; i++) {
                const worker = await Tesseract.createWorker('kor+eng', 1, { // 한국어+영어
                    // logger: m => console.log(m) // 진행 상황 로깅
                });
                tesseractScheduler.addWorker(worker);
            }
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
            alert(`오류: ${error.message}. 페이지를 새로고침하거나 카메라 권한을 확인해주세요.`);
        }
    }

    // --- 카메라 설정 ---
    async function setupCamera() {
        try {
            if (localStream) { // 기존 스트림이 있다면 중지
                localStream.getTracks().forEach(track => track.stop());
            }
            const constraints = {
                video: {
                    facingMode: 'environment', // 후면 카메라 우선
                    width: { ideal: 1280 }, // 원하는 해상도
                    height: { ideal: 720 }
                },
                audio: false
            };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            videoElement.srcObject = localStream;
            videoElement.onloadedmetadata = () => {
                captureBtn.disabled = false;
                // 비디오 로드 후 스캔창 비율에 맞게 비디오 영역 조절 (선택적 고급 기능)
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
        // 인식 모드 설정도 유사하게 로드 가능
    }
    function saveSettings() {
        localStorage.setItem('couponScanner_couponLength', couponLengthInput.value);
    }

    // --- 이벤트 리스너 설정 ---
    function setupEventListeners() {
        captureBtn.addEventListener('click', handleManualCapture);
        addToListBtn.addEventListener('click', addCandidateToList);
        
        couponLengthInput.addEventListener('change', saveSettings);
        // recognitionModeSelect.addEventListener('change', handleModeChange); // 자동 인식 모드 변경 시

        copyAllBtn.addEventListener('click', copyAllCouponsToClipboard);
        shareAllBtn.addEventListener('click', shareAllCoupons);
        exportTxtBtn.addEventListener('click', exportCouponsAsTextFile);
        deleteAllBtn.addEventListener('click', deleteAllCoupons);

        // 동적으로 추가되는 삭제 버튼에 대한 이벤트 위임
        couponListULElement.addEventListener('click', function(event) {
            if (event.target && event.target.classList.contains('delete-item-btn')) {
                const codeToDelete = event.target.dataset.code;
                deleteCoupon(codeToDelete);
            }
        });
    }

    // --- 수동 캡처 처리 ---
    async function handleManualCapture() {
        if (!localStream || !tesseractScheduler) {
            ocrStatusElement.textContent = '카메라 또는 OCR 엔진이 준비되지 않았습니다.';
            return;
        }
        
        captureBtn.disabled = true;
        addToListBtn.style.display = 'none';
        recognizedCodeCandidateElement.textContent = '';
        ocrStatusElement.textContent = '이미지 캡처 중...';

        try {
            // 스캔 창 영역만 캡처
            const videoRect = videoElement.getBoundingClientRect();
            const scanWindowRect = scanWindow.getBoundingClientRect(); // 스캔창의 실제 화면상 위치/크기
            
            const scaleX = videoElement.videoWidth / videoRect.width;
            const scaleY = videoElement.videoHeight / videoRect.height;

            // videoRect 기준으로 scanWindowRect의 상대적 위치 계산
            const cropX = (scanWindowRect.left - videoRect.left) * scaleX;
            const cropY = (scanWindowRect.top - videoRect.top) * scaleY;
            const cropWidth = scanWindowRect.width * scaleX;
            const cropHeight = scanWindowRect.height * scaleY;
            
            captureCanvas.width = cropWidth;
            captureCanvas.height = cropHeight;
            const context = captureCanvas.getContext('2d');
            // 스캔 창 영역만 그리기
            context.drawImage(videoElement, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
            
            const imageDataUrl = captureCanvas.toDataURL('image/png');
            ocrStatusElement.textContent = '쿠폰 번호 인식 중... 잠시만 기다려주세요.';
            
            // Tesseract.js로 OCR 수행
            const { data: { text } } = await tesseractScheduler.addJob('recognize', imageDataUrl);
            processOCRResult(text);

        } catch (error) {
            console.error("캡처 또는 OCR 오류:", error);
            ocrStatusElement.textContent = `오류 발생: ${error.message}`;
        } finally {
            captureBtn.disabled = false;
        }
    }

    // --- OCR 결과 처리 ---
    function processOCRResult(rawText) {
        ocrStatusElement.textContent = '인식 완료. 결과 분석 중...';
        console.log("원본 OCR 텍스트:", rawText);

        // 1. 하이픈 제거 및 공백 제거
        let processedText = rawText.replace(/-/g, '').replace(/\s+/g, '');
        
        // 2. 쿠폰 자릿수 설정 가져오기 (예: "12" 또는 "8-16")
        const lengthPattern = couponLengthInput.value.trim();
        let minLength = 0, maxLength = Infinity;

        if (lengthPattern.includes('-')) {
            const parts = lengthPattern.split('-');
            minLength = parseInt(parts[0], 10) || 0;
            maxLength = parseInt(parts[1], 10) || Infinity;
        } else if (lengthPattern) {
            minLength = parseInt(lengthPattern, 10) || 0;
            maxLength = minLength; // 고정 길이
        }

        // 3. 유효한 문자(영숫자) 필터링 및 자릿수 확인 (더 정교한 필터링 필요 가능성 있음)
        // 한글 등 다른 문자 제거 (정규식 개선 필요)
        const alphanumericText = processedText.replace(/[^A-Za-z0-9]/g, ''); 
        console.log("영숫자 필터링 후:", alphanumericText);

        if (alphanumericText.length >= minLength && alphanumericText.length <= maxLength) {
            currentCandidateCode = alphanumericText;
            recognizedCodeCandidateElement.textContent = currentCandidateCode;
            addToListBtn.style.display = 'inline-block';
            ocrStatusElement.textContent = '인식된 번호를 확인하고 목록에 추가하세요.';
        } else {
            currentCandidateCode = null;
            recognizedCodeCandidateElement.textContent = '-';
            addToListBtn.style.display = 'none';
            ocrStatusElement.textContent = `인식된 내용(${alphanumericText})이 설정된 자릿수(${lengthPattern})와 맞지 않습니다.`;
            if (!alphanumericText && rawText.trim()) {
                 ocrStatusElement.textContent += ` (원본: ${rawText.trim()})`;
            }
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
        }
    }

    function renderCouponList() {
        couponListULElement.innerHTML = ''; // 목록 비우기
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
                deleteBtn.dataset.code = code; // data 속성으로 삭제할 코드 저장
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
                    // 구형 브라우저를 위한 대체 수단 (선택적)
                    // prompt("아래 내용을 직접 복사하세요:", textToCopy);
                });
        } else {
            // navigator.clipboard API가 지원되지 않는 경우 (HTTPS가 아니거나 매우 구형 브라우저)
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
                // 사용자가 공유를 취소한 경우는 오류로 처리하지 않을 수 있음 (err.name === 'AbortError')
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
        URL.revokeObjectURL(link.href); // 메모리 해제
        ocrStatusElement.textContent = `${filename} 파일이 다운로드되었습니다.`;
    }

    // --- 앱 시작 ---
    initialize();
});
