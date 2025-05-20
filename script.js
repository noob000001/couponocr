document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 요소 가져오기 ---
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
        ocrStatusElement.textContent = 'OCR 엔진을 로드 중입니다...';
        if (ocrRawDebugOutputElement) ocrRawDebugOutputElement.textContent = '';
        try {
            tesseractScheduler = Tesseract.createScheduler();
            const workerPromises = [];
            for (let i = 0; i < tesseractWorkersCount; i++) {
                const worker = await Tesseract.createWorker('kor+eng', 1, { /* logger: m => console.log(m) */ });
                await worker.setParameters({
                    tessedit_char_whitelist: TESS_WHITELIST,
                });
                tesseractScheduler.addWorker(worker);
                workerPromises.push(Promise.resolve()); 
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
                deleteCoupon(codeToDelete);
            }
        });
    }

    // === object-fit: contain 상태에서 실제 비디오 영역 계산 함수 ===
    function getContainedVideoDimensions(videoElement) {
        const videoIntrinsicWidth = videoElement.videoWidth;
        const videoIntrinsicHeight = videoElement.videoHeight;
        const videoElemClientWidth = videoElement.clientWidth; // CSS에 의해 결정된 요소의 너비
        const videoElemClientHeight = videoElement.clientHeight; // CSS에 의해 결정된 요소의 높이

        const videoAspectRatio = videoIntrinsicWidth / videoIntrinsicHeight;
        const elemAspectRatio = videoElemClientWidth / videoElemClientHeight;

        let renderWidth, renderHeight, xOffset, yOffset;

        if (videoAspectRatio > elemAspectRatio) { // 비디오가 요소보다 넓은 경우 (위아래 레터박스)
            renderWidth = videoElemClientWidth;
            renderHeight = videoElemClientWidth / videoAspectRatio;
            xOffset = 0;
            yOffset = (videoElemClientHeight - renderHeight) / 2;
        } else { // 비디오가 요소보다 길거나 같은 비율인 경우 (좌우 레터박스 또는 꽉 참)
            renderHeight = videoElemClientHeight;
            renderWidth = videoElemClientHeight * videoAspectRatio;
            yOffset = 0;
            xOffset = (videoElemClientWidth - renderWidth) / 2;
        }
        return {
            x: xOffset, // 비디오 요소 내 실제 그려지는 영상의 시작 X 오프셋
            y: yOffset, // 비디오 요소 내 실제 그려지는 영상의 시작 Y 오프셋
            width: renderWidth, // 실제 그려지는 영상의 너비
            height: renderHeight // 실제 그려지는 영상의 높이
        };
    }
    // === 함수 끝 ===

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
            // === 실제 비디오가 그려지는 영역과 스케일 계산 (수정된 로직) ===
            const renderedVideo = getContainedVideoDimensions(videoElement);

            const videoIntrinsicWidth = videoElement.videoWidth;
            const videoIntrinsicHeight = videoElement.videoHeight;

            // 스캔 창의 화면상 위치와 크기 (videoElement 기준)
            const videoElemRect = videoElement.getBoundingClientRect(); // videoElement의 화면상 위치/크기
            const scanWindowRect = scanWindow.getBoundingClientRect();  // 스캔 창 테두리의 화면상 위치/크기

            // videoElement 내부의 실제 비디오 영역 기준, 스캔 창의 상대적 시작 위치 (비율)
            // (스캔 창의 시작점 - 비디오 요소의 시작점 - 레터박스 오프셋) / 실제 비디오 너비(높이)
            const scanX_relative_to_video_content_start = (scanWindowRect.left - videoElemRect.left - renderedVideo.x) / renderedVideo.width;
            const scanY_relative_to_video_content_start = (scanWindowRect.top - videoElemRect.top - renderedVideo.y) / renderedVideo.height;

            // 스캔 창의 크기 (실제 비디오 영역 대비 비율)
            const scanWidth_relative_to_video_content = scanWindowRect.width / renderedVideo.width;
            const scanHeight_relative_to_video_content = scanWindowRect.height / renderedVideo.height;

            // 원본 비디오 해상도에서 잘라낼 소스(source) 영역 계산
            const sx = videoIntrinsicWidth * scanX_relative_to_video_content_start;
            const sy = videoIntrinsicHeight * scanY_relative_to_video_content_start;
            const sWidth = videoIntrinsicWidth * scanWidth_relative_to_video_content;
            const sHeight = videoIntrinsicHeight * scanHeight_relative_to_video_content;

            // 잘라낼 영역이 유효한지 최종 확인
            if (sWidth <= 0 || sHeight <= 0 || sx < 0 || sy < 0 || (sx + sWidth > videoIntrinsicWidth) || (sy + sHeight > videoIntrinsicHeight)) {
                 console.error("최종 잘라낼 영역 계산 오류 또는 스캔창이 비디오 영역 바깥에 위치:", {sx, sy, sWidth, sHeight, videoIntrinsicWidth, videoIntrinsicHeight});
                 throw new Error("스캔 창 영역이 비디오 범위를 벗어났습니다. 스캔 창 크기나 위치를 확인하세요.");
            }
            
            captureCanvas.width = sWidth; // 캔버스 크기를 잘라낼 이미지 크기로 설정
            captureCanvas.height = sHeight;
            const context = captureCanvas.getContext('2d');
            context.drawImage(
                videoElement,    
                sx, sy, sWidth, sHeight, // 소스 사각형 (원본 비디오에서)
                0, 0, sWidth, sHeight    // 대상 사각형 (캔버스에서)
            );
            // === 잘라내기 로직 수정 끝 ===
            
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

    function processOCRResult(rawText) {
        ocrStatusElement.textContent = '인식 완료. 결과 분석 중...';
        console.log("원본 OCR 텍스트:", rawText);

        if (ocrRawDebugOutputElement) {
            ocrRawDebugOutputElement.textContent = `[OCR 원본]: "${rawText}" (길이: ${rawText ? rawText.length : 0})`;
        }

        let workingText = rawText ? rawText.replace(/\s+/g, '') : ''; 
        const selectedFormat = couponFormatSelect.value;
        let finalFilteredText = '';

        if (selectedFormat === 'alphanumeric') {
            workingText = workingText.replace(/-/g, ''); 
            finalFilteredText = workingText.replace(/[^A-Za-z0-9]/g, '');
        } else if (selectedFormat === 'alphanumeric_hyphen') {
            finalFilteredText = workingText.replace(/[^A-Za-z0-9\-]/g, '');
        } else { 
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
            if (finalFilteredText.length === 0 && rawText && rawText.trim().length > 0) {
                message += ` (유효한 문자를 찾지 못함)`;
            }
            message += ` (OCR 원본은 위 파란색 텍스트 참고)`;
            ocrStatusElement.textContent = message;
        }
    }

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

    initialize();
});
