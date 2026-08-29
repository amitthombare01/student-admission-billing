const loginShell = document.getElementById('loginShell');
const appShell = document.getElementById('appShell');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginError = document.getElementById('loginError');
const loginSuccess = document.getElementById('loginSuccess');
const registerError = document.getElementById('registerError');
const registerSuccess = document.getElementById('registerSuccess');
const form = document.getElementById('studentForm');
const formSection = document.getElementById('formSection');
const recordsSection = document.getElementById('recordsSection');
const billsContainer = document.getElementById('billsContainer');
const navButtons = document.querySelectorAll('.nav-btn');
const classNameInput = document.getElementById('className');
const amountPaidInput = document.getElementById('amountPaid');
const paymentModeInput = document.getElementById('paymentMode');
const offlineBanner = document.getElementById('offlineBanner');
const showLoginBtn = document.getElementById('showLoginBtn');
const showRegisterBtn = document.getElementById('showRegisterBtn');
const dateOfBirthInput = document.getElementById('dateOfBirth');
const admissionDateInput = document.getElementById('admissionDate');
const authSwitch = document.getElementById('authSwitch');
const emailVerificationPanel = document.getElementById('emailVerificationPanel');
const confirmEmailBtn = document.getElementById('confirmEmailBtn');
const verificationLoginBtn = document.getElementById('verificationLoginBtn');
const emailVerificationSuccess = document.getElementById('emailVerificationSuccess');
const emailVerificationError = document.getElementById('emailVerificationError');
const resendVerificationBtn = document.getElementById('resendVerificationBtn');
const passwordChangeForm = document.getElementById('passwordChangeForm');
const DEFAULT_SCHOOL_NAME = 'Phoenix English, Marathi Primary, Secondary, and Junior College, Mahud B.K, Tal- Sangola, Dist- Solapur.';
let recordsCache = [];
let authToken = sessionStorage.getItem('userAuthToken') || '';
let currentUser = null;
let emailVerificationToken = '';

loginForm.addEventListener('submit', handleLogin);
registerForm?.addEventListener('submit', handleRegister);
passwordChangeForm?.addEventListener('submit', handlePasswordChange);
form.addEventListener('submit', async function (event) {
    event.preventDefault();
    await generateBills();
});
form.addEventListener('reset', function () {
    sessionStorage.removeItem('studentData');
    window.setTimeout(function () {
        saveDraftFormData();
    }, 0);
});
form.addEventListener('input', saveDraftFormData);
classNameInput.addEventListener('change', function () {
    saveDraftFormData();
});
amountPaidInput.addEventListener('input', saveDraftFormData);
paymentModeInput.addEventListener('change', saveDraftFormData);
showLoginBtn?.addEventListener('click', function () {
    toggleAuthMode('login');
});
showRegisterBtn?.addEventListener('click', function () {
    toggleAuthMode('register');
});
confirmEmailBtn?.addEventListener('click', confirmEmailAddress);
verificationLoginBtn?.addEventListener('click', showLoginAfterVerification);
resendVerificationBtn?.addEventListener('click', resendEmailVerification);
bindCalendarInput('dateOfBirth', 'dateOfBirthPicker', 'dateOfBirthPickerBtn');
bindCalendarInput('admissionDate', 'admissionDatePicker', 'admissionDatePickerBtn');

function toggleAuthMode(mode) {
    const isLogin = mode === 'login';
    loginForm.style.display = isLogin ? 'flex' : 'none';
    registerForm.style.display = isLogin ? 'none' : 'flex';
    showLoginBtn.classList.toggle('active', isLogin);
    showRegisterBtn.classList.toggle('active', !isLogin);
    loginError.style.display = 'none';
    loginSuccess.style.display = 'none';
    registerError.style.display = 'none';
    registerSuccess.style.display = 'none';
}

async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    try {
        const response = await apiRequest('/api/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
            useAuth: false
        });
        authToken = response.token;
        sessionStorage.setItem('userAuthToken', authToken);
        currentUser = response.user;
        loginError.style.display = 'none';
        applyUserSession(response.user, response.settings || {});
        await initializeAppAfterLogin();
    } catch (error) {
        loginError.textContent = error.message || 'Login failed.';
        loginError.style.display = 'block';
    }
}

async function handleRegister(event) {
    event.preventDefault();
    const fullName = document.getElementById('registerFullName').value.trim();
    const username = document.getElementById('registerUsername').value.trim();
    const password = document.getElementById('registerPassword').value;

    registerError.style.display = 'none';
    registerSuccess.style.display = 'none';

    try {
        const response = await apiRequest('/api/register', {
            method: 'POST',
            body: JSON.stringify({ fullName, username, password }),
            useAuth: false
        });
        registerForm.reset();
        registerSuccess.textContent = response.message || 'Registration submitted. Check your email and confirm the address.';
        registerSuccess.style.display = 'block';
        document.getElementById('loginUsername').value = username;
    } catch (error) {
        registerError.textContent = error.message || 'Registration failed.';
        registerError.style.display = 'block';
    }
}

function initializeEmailVerification() {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('verify') || '';
    if (!token) return false;

    emailVerificationToken = token;
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    authSwitch.style.display = 'none';
    loginForm.style.display = 'none';
    registerForm.style.display = 'none';
    emailVerificationPanel.style.display = 'flex';
    return true;
}

async function confirmEmailAddress() {
    if (!emailVerificationToken) return;
    confirmEmailBtn.disabled = true;
    emailVerificationError.style.display = 'none';
    try {
        const response = await apiRequest('/api/verify-email', {
            method: 'POST',
            body: JSON.stringify({ token: emailVerificationToken }),
            useAuth: false
        });
        emailVerificationToken = '';
        confirmEmailBtn.style.display = 'none';
        emailVerificationSuccess.textContent = response.message || 'Email confirmed. Your request is waiting for administrator approval.';
        emailVerificationSuccess.style.display = 'block';
        verificationLoginBtn.style.display = 'inline-flex';
    } catch (error) {
        emailVerificationError.textContent = error.message || 'Could not confirm this email address.';
        emailVerificationError.style.display = 'block';
        confirmEmailBtn.disabled = false;
    }
}

function showLoginAfterVerification() {
    emailVerificationPanel.style.display = 'none';
    authSwitch.style.display = 'flex';
    toggleAuthMode('login');
}

async function resendEmailVerification() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    loginSuccess.style.display = 'none';
    loginError.style.display = 'none';
    if (!username || !password) {
        loginError.textContent = 'Enter the same email and password used during registration, then try again.';
        loginError.style.display = 'block';
        return;
    }

    resendVerificationBtn.disabled = true;
    try {
        const response = await apiRequest('/api/resend-verification', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
            useAuth: false
        });
        loginSuccess.textContent = response.message;
        loginSuccess.style.display = 'block';
    } catch (error) {
        loginError.textContent = error.message || 'Could not request another confirmation email.';
        loginError.style.display = 'block';
    } finally {
        resendVerificationBtn.disabled = false;
    }
}

async function logout() {
    try {
        await apiRequest('/api/logout', { method: 'POST' });
    } catch (error) {
        // Ignore logout network errors and clear local session anyway.
    }

    authToken = '';
    currentUser = null;
    recordsCache = [];
    sessionStorage.removeItem('userAuthToken');
    sessionStorage.removeItem('studentData');
    loginShell.style.display = 'flex';
    appShell.style.display = 'none';
}

async function handlePasswordChange(event) {
    event.preventDefault();
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmNewPassword = document.getElementById('confirmNewPassword').value;
    const success = document.getElementById('passwordChangeSuccess');
    const error = document.getElementById('passwordChangeError');
    success.style.display = 'none';
    error.style.display = 'none';
    if (newPassword !== confirmNewPassword) {
        error.textContent = 'The new passwords do not match.';
        error.style.display = 'block';
        return;
    }
    try {
        const response = await apiRequest('/api/account/password', {
            method: 'PUT',
            body: JSON.stringify({ currentPassword, newPassword })
        });
        authToken = response.token;
        sessionStorage.setItem('userAuthToken', authToken);
        passwordChangeForm.reset();
        success.textContent = response.message || 'Password changed successfully.';
        success.style.display = 'block';
    } catch (requestError) {
        error.textContent = requestError.message || 'Could not change your password.';
        error.style.display = 'block';
    }
}

function applyUserSession(user, settings) {
    currentUser = user;
    document.getElementById('userFullName').textContent = user.fullName;
    document.getElementById('userRole').textContent = user.role;
    const adminPanelBtn = document.getElementById('adminPanelBtn');
    if (adminPanelBtn) {
        adminPanelBtn.style.display = user.role === 'admin' ? 'inline-flex' : 'none';
    }
    applyStoredBackground(settings.backgroundImage || '');
}

async function initializeAppAfterLogin() {
    loginShell.style.display = 'none';
    appShell.style.display = 'block';
    updateOfflineBanner();
    restoreDraftFormData();
    await loadRecords();
    showSection('dashboardSection', navButtons[0]);
}

function bindCalendarInput(inputId, pickerId, buttonId) {
    const textInput = document.getElementById(inputId);
    const pickerInput = document.getElementById(pickerId);
    const button = document.getElementById(buttonId);

    if (!textInput || !pickerInput || !button) {
        return;
    }

    textInput.addEventListener('input', function () {
        textInput.value = formatDateTyping(textInput.value);
        const normalized = normalizeDateInput(textInput.value);
        pickerInput.value = normalized || '';
    });

    textInput.addEventListener('blur', function () {
        const normalized = normalizeDateInput(textInput.value);
        if (normalized) {
            textInput.value = formatDate(normalized);
            pickerInput.value = normalized;
        }
    });

    button.addEventListener('click', function () {
        if (typeof pickerInput.showPicker === 'function') {
            pickerInput.showPicker();
            return;
        }
        pickerInput.click();
    });

    pickerInput.addEventListener('change', function () {
        textInput.value = pickerInput.value ? formatDate(pickerInput.value) : '';
        saveDraftFormData();
    });
}

function showSection(sectionId, btnElement) {
    const dashboardSection = document.getElementById('dashboardSection');
    const passwordSection = document.getElementById('passwordSection');
    formSection.style.display = 'none';
    recordsSection.style.display = 'none';
    billsContainer.style.display = 'none';
    dashboardSection.style.display = 'none';
    if (passwordSection) passwordSection.style.display = 'none';

    document.getElementById(sectionId).style.display = 'block';

    navButtons.forEach(btn => btn.classList.remove('active'));
    if (btnElement) {
        btnElement.classList.add('active');
    }

    if (sectionId === 'recordsSection') {
        loadRecords();
    }

    if (sectionId === 'dashboardSection') {
        refreshDashboard();
    }

    window.scrollTo(0, 0);
}

function applyStoredBackground(imageData) {
    const preview = document.getElementById('bgPreview');
    if (imageData) {
        document.body.style.backgroundImage = `url('${imageData}')`;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundAttachment = 'fixed';
        document.body.style.backgroundPosition = 'center';
        if (preview) {
            preview.src = imageData;
            preview.style.display = 'block';
        }
    } else {
        document.body.style.backgroundImage = 'none';
        document.body.style.background = 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)';
        if (preview) {
            preview.style.display = 'none';
        }
    }
}

async function generateBills() {
    const payload = {
        schoolName: DEFAULT_SCHOOL_NAME,
        studentName: document.getElementById('studentName').value.trim(),
        className: classNameInput.value,
        parentName: document.getElementById('parentName').value.trim(),
        contactNumber: document.getElementById('contactNumber').value.trim(),
        dateOfBirth: normalizeDateInput(document.getElementById('dateOfBirth').value),
        address: document.getElementById('address').value.trim(),
        tuitionFee: getFeeValue('tuitionFee'),
        transportFee: getFeeValue('transportFee'),
        sportsFee: getFeeValue('sportsFee'),
        otherFee: getFeeValue('otherFee'),
        paymentMode: document.getElementById('paymentMode').value,
        amountPaid: getFeeValue('amountPaid'),
        sessionYear: document.getElementById('sessionYear').value.trim(),
        admissionDate: normalizeDateInput(document.getElementById('admissionDate').value)
    };

    if (document.getElementById('dateOfBirth').value && !payload.dateOfBirth) {
        alert('Date of Birth must be in dd/mm/yyyy format.');
        return;
    }
    if (!payload.admissionDate) {
        alert('Admission Date must be in dd/mm/yyyy format.');
        return;
    }

    try {
        const response = await apiRequest('/api/records', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const formData = response.record;
        recordsCache.unshift(formData);
        sessionStorage.removeItem('studentData');

        const totalAmount = getTotalAmount(formData);
        generateBillCopy('schoolBill', formData, totalAmount, 'School Copy');
        generateBillCopy('studentBill', formData, totalAmount, 'Student Copy');
        refreshDashboard();

        formSection.style.display = 'none';
        recordsSection.style.display = 'none';
        billsContainer.style.display = 'block';
        window.scrollTo(0, 0);
    } catch (error) {
        alert(error.message || 'Could not save the admission record.');
    }
}

function generateBillCopy(targetId, data, totalAmount, billType) {
    const amountPaid = getAmountPaid(data);
    const balanceAmount = getBalanceAmount(data);
    const billHTML = `
        <div class="bill-header">
            <div class="school-name">${escapeHtml(data.schoolName)}</div>
            <div class="bill-type">${billType}</div>
            <div class="bill-date">Date: ${formatDate(new Date())}</div>
        </div>

        <div class="bill-content">
            <div class="info-section student-section">
                <h3>Student Details</h3>
                <div class="info-row"><span class="info-label">Name:</span><span class="info-value">${escapeHtml(data.studentName)}</span></div>
                <div class="info-row"><span class="info-label">Class:</span><span class="info-value">${escapeHtml(data.className)}</span></div>
                ${data.dateOfBirth ? `<div class="info-row"><span class="info-label">Date of Birth:</span><span class="info-value">${formatDate(data.dateOfBirth)}</span></div>` : ''}
            </div>

            <div class="info-section parent-section">
                <h3>Parent/Guardian Details</h3>
                <div class="info-row"><span class="info-label">Name:</span><span class="info-value">${escapeHtml(data.parentName)}</span></div>
                <div class="info-row"><span class="info-label">Contact Number:</span><span class="info-value">${escapeHtml(data.contactNumber)}</span></div>
            </div>

            <div class="info-section admission-section">
                <h3>Admission Details</h3>
                <div class="info-row"><span class="info-label">Session Year:</span><span class="info-value">${escapeHtml(data.sessionYear)}</span></div>
                <div class="info-row"><span class="info-label">Admission Date:</span><span class="info-value">${formatDate(data.admissionDate)}</span></div>
                <div class="info-row"><span class="info-label">Payment Mode:</span><span class="info-value">${formatPaymentMode(data.paymentMode)}</span></div>
            </div>

            <div class="info-section fee-section">
                <h3>Fee Breakdown</h3>
                <table class="fee-table">
                    <thead>
                        <tr><th>Fee Type</th><th>Amount (Rs)</th></tr>
                    </thead>
                    <tbody>
                        ${renderFeeRow('Total Fees', data.tuitionFee)}
                        ${renderFeeRow('Transport Fee', data.transportFee)}
                        ${renderFeeRow('Sports Fee', data.sportsFee)}
                        ${renderFeeRow('Other Fees', data.otherFee)}
                        <tr class="total-row"><td>Total Fee</td><td class="total-amount">${formatCurrency(totalAmount)}</td></tr>
                        <tr><td>Fee Paid</td><td>${formatCurrency(amountPaid)}</td></tr>
                        <tr><td>Balance Due</td><td>${formatCurrency(balanceAmount)}</td></tr>
                    </tbody>
                </table>
            </div>

            ${data.address ? `<div class="info-section address-section"><h3>Address</h3><div class="info-row"><span class="info-value">${escapeHtml(data.address).replace(/\n/g, '<br>')}</span></div></div>` : ''}
        </div>

        <div class="bill-footer">
            <p>This is an auto-generated document from Student Admission System.</p>
            <p>Please retain this copy for your records.</p>
        </div>
    `;

    document.getElementById(targetId).innerHTML = billHTML;
}

function renderFeeRow(label, amount) {
    if (Number(amount) <= 0) {
        return '';
    }
    return `<tr><td>${label}</td><td>${formatCurrency(amount)}</td></tr>`;
}

function printBills() {
    const schoolBill = document.getElementById('schoolBill');
    const studentBill = document.getElementById('studentBill');
    if (!schoolBill || !studentBill || !schoolBill.innerHTML.trim() || !studentBill.innerHTML.trim()) {
        return;
    }

    const printDocument = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Print Bills</title>
            <style>
                @page {
                    size: A4 portrait;
                    margin: 4mm;
                }

                * {
                    box-sizing: border-box;
                }

                html,
                body {
                    margin: 0;
                    padding: 0;
                    background: #fff;
                    color: #14213d;
                    font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
                }

                body {
                    font-size: 7.4pt;
                }

                .print-sheet {
                    display: grid;
                    grid-template-columns: 1fr;
                    grid-template-rows: 1fr 1fr;
                    gap: 2mm;
                    height: calc(297mm - 8mm);
                }

                .print-copy {
                    display: flex;
                    flex-direction: column;
                    min-height: 0;
                    padding: 4mm 5mm 3mm;
                    border: 1px solid #d7deea;
                    overflow: hidden;
                }

                .copy-title {
                    margin: 0 0 1.5mm;
                    text-align: center;
                    color: #1d4ed8;
                    font-size: 7.1pt;
                    font-weight: 800;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                }

                .bill {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    min-height: 0;
                }

                .bill-header {
                    text-align: center;
                    margin-bottom: 2.5mm;
                    padding-bottom: 2mm;
                    border-bottom: 1px solid #cdd8ea;
                }

                .school-name {
                    font-size: 9pt;
                    font-weight: 800;
                    line-height: 1.18;
                    margin-bottom: 0.5mm;
                }

                .bill-type {
                    font-size: 6.8pt;
                    font-weight: 800;
                    color: #1d4ed8;
                    letter-spacing: 0.1em;
                    text-transform: uppercase;
                }

                .bill-date {
                    margin-top: 0.6mm;
                    font-size: 6.4pt;
                    color: #5b6477;
                }

                .bill-content {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
                    column-gap: 6mm;
                    row-gap: 1.2mm;
                    flex: 1 1 auto;
                    min-height: 0;
                }

                .info-section {
                    margin-bottom: 0;
                }

                .info-section h3 {
                    margin: 0 0 1mm;
                    padding-bottom: 0.8mm;
                    border-bottom: 1px solid #d7deea;
                    font-size: 6.9pt;
                    font-weight: 800;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                }

                .info-row {
                    display: flex;
                    justify-content: space-between;
                    gap: 4px;
                    margin-bottom: 0.8mm;
                    font-size: 6.5pt;
                    line-height: 1.22;
                }

                .info-label {
                    flex: 0 0 42%;
                    font-weight: 700;
                    color: #5b6477;
                }

                .info-value {
                    flex: 1 1 auto;
                    text-align: right;
                    word-break: break-word;
                }

                .fee-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 0.8mm;
                }

                .fee-table th,
                .fee-table td {
                    border: 1px solid #d7deea;
                    padding: 0.9mm 1.2mm;
                    font-size: 6.4pt;
                    line-height: 1.18;
                }

                .fee-table th {
                    text-align: left;
                    background: #eef4ff;
                }

                .total-row td,
                .total-amount {
                    font-weight: 800;
                }

                .bill-footer {
                    margin-top: auto;
                    padding-top: 1.2mm;
                    border-top: 1px solid #d7deea;
                    text-align: center;
                    font-size: 6pt;
                    line-height: 1.2;
                    color: #5b6477;
                }

                .admission-section,
                .fee-section,
                .address-section {
                    grid-column: 1 / -1;
                }
            </style>
        </head>
        <body>
            <div class="print-sheet">
                <section class="print-copy">
                    <h2 class="copy-title">School Copy</h2>
                    <div class="bill">${schoolBill.innerHTML}</div>
                </section>
                <section class="print-copy">
                    <h2 class="copy-title">Student Copy</h2>
                    <div class="bill">${studentBill.innerHTML}</div>
                </section>
            </div>
        </body>
        </html>
    `;

    const existingFrame = document.getElementById('billPrintFrame');
    if (existingFrame) {
        existingFrame.remove();
    }

    const printFrame = document.createElement('iframe');
    printFrame.id = 'billPrintFrame';
    printFrame.setAttribute('aria-hidden', 'true');
    printFrame.style.position = 'fixed';
    printFrame.style.right = '0';
    printFrame.style.bottom = '0';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    printFrame.style.opacity = '0';
    document.body.appendChild(printFrame);

    const cleanupPrintFrame = function () {
        window.setTimeout(function () {
            if (printFrame.parentNode) {
                printFrame.parentNode.removeChild(printFrame);
            }
        }, 300);
    };

    const frameWindow = printFrame.contentWindow;
    const frameDocument = printFrame.contentDocument || (frameWindow ? frameWindow.document : null);
    if (!frameWindow || !frameDocument) {
        cleanupPrintFrame();
        return;
    }

    frameDocument.open();
    frameDocument.write(printDocument);
    frameDocument.close();

    window.setTimeout(function () {
        frameWindow.focus();
        if ('onafterprint' in frameWindow) {
            frameWindow.onafterprint = cleanupPrintFrame;
        }
        frameWindow.print();
        window.setTimeout(cleanupPrintFrame, 1500);
    }, 250);
}

function goBackFromBills() {
    billsContainer.style.display = 'none';
    recordsSection.style.display = 'block';
    navButtons.forEach(btn => btn.classList.remove('active'));
    if (navButtons[2]) {
        navButtons[2].classList.add('active');
    }
    loadRecords();
    window.scrollTo(0, 0);
}

async function loadRecords() {
    const tbody = document.getElementById('recordsBody');
    tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: #7c8199;">Loading records...</td></tr>';

    try {
        const response = await apiRequest('/api/records');
        recordsCache = response.records || [];
        refreshDashboard();
        renderRecords(recordsCache);
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; color: #b91c1c;">${escapeHtml(error.message || 'Could not load records.')}</td></tr>`;
    }
}

function refreshDashboard() {
    const totalStudents = recordsCache.length;
    const classCounts = recordsCache.reduce((accumulator, record) => {
        const className = String(record.className || '').trim();
        if (className) {
            accumulator[className] = (accumulator[className] || 0) + 1;
        }
        return accumulator;
    }, {});
    const totalClasses = Object.keys(classCounts).length;
    const totalFees = recordsCache.reduce((sum, record) => sum + getTotalAmount(record), 0);
    const totalPaid = recordsCache.reduce((sum, record) => sum + getAmountPaid(record), 0);
    const pendingFees = recordsCache.reduce((sum, record) => sum + getBalanceAmount(record), 0);
    const todayKey = new Date().toDateString();
    const todayAdmissions = recordsCache.filter(record => new Date(record.dateAdded).toDateString() === todayKey).length;
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const monthlyRecords = recordsCache.filter(record => {
        const addedDate = new Date(record.dateAdded);
        return addedDate.getMonth() === currentMonth && addedDate.getFullYear() === currentYear;
    });
    const monthlyFees = monthlyRecords.reduce((sum, record) => sum + getAmountPaid(record), 0);
    const topClassEntry = Object.entries(classCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))[0];
    const recentList = document.getElementById('recentAdmissionsList');
    const classStrengthList = document.getElementById('classStrengthList');
    const monthlySummaryList = document.getElementById('monthlySummaryList');

    document.getElementById('totalStudentsCard').textContent = String(totalStudents);
    document.getElementById('totalClassesCard').textContent = String(totalClasses);
    document.getElementById('totalFeesCard').textContent = formatCurrency(totalFees);
    document.getElementById('todayAdmissionsCard').textContent = String(todayAdmissions);
    document.getElementById('monthlyFeesCard').textContent = formatCurrency(totalPaid);
    document.getElementById('pendingFeesCard').textContent = formatCurrency(pendingFees);

    const recentRecords = [...recordsCache].sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded)).slice(0, 5);
    recentList.innerHTML = recentRecords.length
        ? recentRecords.map(record => `
            <div class="recent-admission-item">
                <div class="recent-admission-main">
                    <strong>${escapeHtml(record.studentName)}</strong>
                    <span>Class ${escapeHtml(record.className)} - Paid ${formatCurrency(getAmountPaid(record))}</span>
                </div>
                <div class="recent-admission-meta">${formatDate(new Date(record.dateAdded))}</div>
            </div>
        `).join('')
        : '<p class="empty-state">No admissions yet.</p>';

    const classFeeSummaries = Object.values(recordsCache.reduce((accumulator, record) => {
        const className = String(record.className || '').trim();
        if (!className) {
            return accumulator;
        }
        if (!accumulator[className]) {
            accumulator[className] = { className, count: 0, total: 0, paid: 0 };
        }
        accumulator[className].count += 1;
        accumulator[className].total += getTotalAmount(record);
        accumulator[className].paid += getAmountPaid(record);
        return accumulator;
    }, {})).sort((a, b) => a.className.localeCompare(b.className, undefined, { numeric: true }));

    classStrengthList.innerHTML = classFeeSummaries.length
        ? classFeeSummaries.map(summary => `
            <div class="summary-row">
                <div>
                    <strong>Class ${escapeHtml(summary.className)}</strong>
                    <span>${summary.count} student${summary.count === 1 ? '' : 's'} | Total ${formatCurrency(summary.total)}</span>
                </div>
                <span>Paid ${formatCurrency(summary.paid)} | Balance ${formatCurrency(summary.total - summary.paid)}</span>
            </div>
        `).join('')
        : '<p class="empty-state">No class data yet.</p>';

    const monthlyBuckets = recordsCache.reduce((accumulator, record) => {
        const addedDate = new Date(record.dateAdded);
        const key = `${addedDate.getFullYear()}-${String(addedDate.getMonth() + 1).padStart(2, '0')}`;
        const label = addedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (!accumulator[key]) {
            accumulator[key] = { label, students: 0, total: 0, paid: 0 };
        }
        accumulator[key].students += 1;
        accumulator[key].total += getTotalAmount(record);
        accumulator[key].paid += getAmountPaid(record);
        return accumulator;
    }, {});

    const sortedMonths = Object.entries(monthlyBuckets).sort((a, b) => b[0].localeCompare(a[0]));
    monthlySummaryList.innerHTML = sortedMonths.length
        ? sortedMonths.map(([, summary]) => `
            <div class="summary-row">
                <div>
                    <strong>${escapeHtml(summary.label)}</strong>
                    <span>${summary.students} admission${summary.students === 1 ? '' : 's'}</span>
                </div>
                <span>${formatCurrency(summary.paid)} / ${formatCurrency(summary.total)}</span>
            </div>
        `).join('')
        : '<p class="empty-state">No monthly data yet.</p>';
}

function renderRecords(records) {
    const tbody = document.getElementById('recordsBody');
    if (!records.length) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: #7c8199;">No records found</td></tr>';
        return;
    }

    tbody.innerHTML = records.map(record => `
        <tr>
            <td>${escapeHtml(record.schoolName)}</td>
            <td>${escapeHtml(record.studentName)}</td>
            <td>${escapeHtml(record.className)}</td>
            <td>${escapeHtml(record.parentName)}</td>
            <td>${escapeHtml(record.sessionYear)}</td>
            <td>${formatCurrency(getTotalAmount(record))}</td>
            <td>${formatCurrency(getAmountPaid(record))}</td>
            <td>${formatCurrency(getBalanceAmount(record))}</td>
            <td>${escapeHtml(formatPaymentMode(record.paymentMode))}</td>
            <td>${formatDate(new Date(record.dateAdded))}</td>
            <td>
                <button class="btn-small" onclick="viewBill(${record.id})">View</button>
            </td>
        </tr>
    `).join('');
}

function filterRecords() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const filtered = recordsCache.filter(record =>
        String(record.schoolName || '').toLowerCase().includes(searchTerm) ||
        String(record.studentName || '').toLowerCase().includes(searchTerm) ||
        String(record.parentName || '').toLowerCase().includes(searchTerm)
    );
    renderRecords(filtered);
}

function viewBill(recordId) {
    const record = recordsCache.find(item => Number(item.id) === Number(recordId));
    if (!record) {
        alert('Record not found.');
        return;
    }

    const totalAmount = getTotalAmount(record);
    generateBillCopy('schoolBill', record, totalAmount, 'School Copy');
    generateBillCopy('studentBill', record, totalAmount, 'Student Copy');
    recordsSection.style.display = 'none';
    billsContainer.style.display = 'block';
    window.scrollTo(0, 0);
}

function getFeeValue(fieldId) {
    return parseFloat(document.getElementById(fieldId).value) || 0;
}

function saveDraftFormData() {
    const draftData = {
        studentName: document.getElementById('studentName').value.trim(),
        className: classNameInput.value,
        parentName: document.getElementById('parentName').value.trim(),
        contactNumber: document.getElementById('contactNumber').value.trim(),
        dateOfBirth: document.getElementById('dateOfBirth').value,
        address: document.getElementById('address').value.trim(),
        tuitionFee: document.getElementById('tuitionFee').value,
        transportFee: document.getElementById('transportFee').value,
        sportsFee: document.getElementById('sportsFee').value,
        otherFee: document.getElementById('otherFee').value,
        paymentMode: document.getElementById('paymentMode').value,
        amountPaid: document.getElementById('amountPaid').value,
        sessionYear: document.getElementById('sessionYear').value.trim(),
        admissionDate: document.getElementById('admissionDate').value
    };
    sessionStorage.setItem('studentData', JSON.stringify(draftData));
}

function restoreDraftFormData() {
    const savedData = sessionStorage.getItem('studentData');
    if (!savedData) {
        return;
    }
    let data;
    try {
        data = JSON.parse(savedData);
    } catch (error) {
        sessionStorage.removeItem('studentData');
        return;
    }
    document.getElementById('studentName').value = data.studentName || '';
    document.getElementById('className').value = data.className || '';
    document.getElementById('parentName').value = data.parentName || '';
    document.getElementById('contactNumber').value = data.contactNumber || '';
    document.getElementById('dateOfBirth').value = data.dateOfBirth || '';
    document.getElementById('address').value = data.address || '';
    document.getElementById('tuitionFee').value = data.tuitionFee || '';
    document.getElementById('transportFee').value = data.transportFee || '';
    document.getElementById('sportsFee').value = data.sportsFee || '';
    document.getElementById('otherFee').value = data.otherFee || '';
    document.getElementById('paymentMode').value = data.paymentMode || 'cash';
    document.getElementById('amountPaid').value = data.amountPaid || '';
    document.getElementById('sessionYear').value = data.sessionYear || '';
    document.getElementById('admissionDate').value = data.admissionDate || '';
}

function updateOfflineBanner() {
    if (!offlineBanner) {
        return;
    }
    if (navigator.onLine) {
        offlineBanner.textContent = 'Connected to the cloud school database.';
        offlineBanner.classList.remove('is-offline');
    } else {
        offlineBanner.textContent = 'No network connection. Reconnect before loading or saving records.';
        offlineBanner.classList.add('is-offline');
    }
}

async function clearAppCaches() {
    if (!('caches' in window)) {
        return;
    }
    const cacheKeys = await caches.keys();
    await Promise.all(
        cacheKeys
            .filter(function (key) {
                return key.indexOf('student-admission-cache') === 0;
            })
            .map(function (key) {
                return caches.delete(key);
            })
    );
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        return;
    }

    try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
            registrations.map(function (registration) {
                return registration.unregister();
            })
        );
    } catch (error) {}

    try {
        await clearAppCaches();
    } catch (error) {}
}

function getTotalAmount(record) {
    return ['tuitionFee', 'transportFee', 'sportsFee', 'otherFee'].reduce((sum, key) => sum + (parseFloat(record[key]) || 0), 0);
}

function getAmountPaid(record) {
    const totalAmount = getTotalAmount(record);
    return Math.min(parseFloat(record.amountPaid) || 0, totalAmount);
}

function getBalanceAmount(record) {
    return Math.max(getTotalAmount(record) - getAmountPaid(record), 0);
}

function formatCurrency(amount) {
    return `Rs ${Number(amount || 0).toFixed(2)}`;
}

function formatPaymentMode(paymentMode) {
    return String(paymentMode || 'cash').toLowerCase() === 'online' ? 'Online' : 'Cash';
}

function formatDate(date) {
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const [year, month, day] = date.split('-');
        return `${day}/${month}/${year}`;
    }
    const normalizedDate = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(normalizedDate.getTime())) {
        return '';
    }
    const day = String(normalizedDate.getDate()).padStart(2, '0');
    const month = String(normalizedDate.getMonth() + 1).padStart(2, '0');
    const year = normalizedDate.getFullYear();
    return `${day}/${month}/${year}`;
}

function normalizeDateInput(value) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }

    const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
        const [, dayText, monthText, yearText] = slashMatch;
        const day = Number(dayText);
        const month = Number(monthText);
        const year = Number(yearText);
        const candidate = new Date(year, month - 1, day);
        if (
            candidate.getFullYear() === year &&
            candidate.getMonth() === month - 1 &&
            candidate.getDate() === day
        ) {
            return `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
        return '';
    }

    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return isoMatch ? text : '';
}

function formatDateTyping(value) {
    const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
    if (digits.length <= 2) {
        return digits;
    }
    if (digits.length <= 4) {
        return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function escapeHtml(text) {
    if (!text) {
        return '';
    }
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, match => map[match]);
}

async function apiRequest(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (options.useAuth !== false && authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(url, { ...options, headers });
    let data = {};
    try {
        data = await response.json();
    } catch (error) {
        data = {};
    }

    if (!response.ok) {
        if (response.status === 401) {
            authToken = '';
            sessionStorage.removeItem('userAuthToken');
            loginShell.style.display = 'flex';
            appShell.style.display = 'none';
        }
        throw new Error(data.error || 'Request failed.');
    }
    return data;
}

window.addEventListener('load', async function () {
    localStorage.removeItem('savedUserLogin');
    localStorage.removeItem('studentData');
    localStorage.removeItem('userAuthToken');
    updateOfflineBanner();
    registerServiceWorker();
    if (initializeEmailVerification()) {
        loginShell.style.display = 'flex';
        appShell.style.display = 'none';
        return;
    }
    if (!authToken) {
        loginShell.style.display = 'flex';
        appShell.style.display = 'none';
        toggleAuthMode('login');
        return;
    }

    try {
        const response = await apiRequest('/api/session');
        applyUserSession(response.user, response.settings || {});
        await initializeAppAfterLogin();
    } catch (error) {
        authToken = '';
        sessionStorage.removeItem('userAuthToken');
        loginShell.style.display = 'flex';
        appShell.style.display = 'none';
        toggleAuthMode('login');
    }
});

window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
