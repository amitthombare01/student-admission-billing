const adminLoginShell = document.getElementById('adminLoginShell');
const adminAppShell = document.getElementById('adminAppShell');
const adminLoginForm = document.getElementById('adminLoginForm');
const adminLoginError = document.getElementById('adminLoginError');
const adminOfflineBanner = document.getElementById('adminOfflineBanner');
const importRecordsInput = document.getElementById('importRecordsInput');
const adminSearchInput = document.getElementById('adminSearchInput');
const reportSessionYearInput = document.getElementById('reportSessionYear');
const createStaffForm = document.getElementById('createStaffForm');

let adminAuthToken = sessionStorage.getItem('adminAuthToken') || '';
let adminCurrentUser = null;
let adminRecordsCache = [];
let usersCache = [];

adminLoginForm.addEventListener('submit', handleAdminLogin);
importRecordsInput.addEventListener('change', importRecords);
adminSearchInput.addEventListener('input', filterAdminRecords);
createStaffForm?.addEventListener('submit', createStaffAccount);

async function handleAdminLogin(event) {
    event.preventDefault();
    const username = document.getElementById('adminUsername').value.trim();
    const password = document.getElementById('adminPassword').value;

    try {
        const response = await adminApiRequest('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
            useAuth: false
        });
        if (response.user.role !== 'admin') {
            throw new Error('Only admin can log in here.');
        }
        adminAuthToken = response.token;
        sessionStorage.setItem('adminAuthToken', adminAuthToken);
        adminCurrentUser = response.user;
        adminLoginError.style.display = 'none';
        applyStoredBackground(response.settings.backgroundImage || '');
        await initializeAdminApp();
    } catch (error) {
        adminLoginError.textContent = error.message || 'Admin login failed.';
        adminLoginError.style.display = 'block';
    }
}

async function adminLogout() {
    try {
        await adminApiRequest('/api/logout', { method: 'POST' });
    } catch (error) {
        // Clear session locally even if request fails.
    }

    adminAuthToken = '';
    adminCurrentUser = null;
    sessionStorage.removeItem('adminAuthToken');
    adminLoginShell.style.display = 'flex';
    adminAppShell.style.display = 'none';
}

async function initializeAdminApp() {
    adminLoginShell.style.display = 'none';
    adminAppShell.style.display = 'block';
    document.getElementById('adminFullName').textContent = adminCurrentUser.fullName;
    document.getElementById('adminRole').textContent = adminCurrentUser.role;
    updateAdminOfflineBanner();
    await Promise.all([loadAdminUsers(), loadAdminRecords()]);
}

async function loadAdminUsers() {
    const response = await adminApiRequest('/api/admin/users');
    usersCache = response.users || [];
    renderUsers();
}

async function createStaffAccount(event) {
    event.preventDefault();
    const success = document.getElementById('createStaffSuccess');
    const error = document.getElementById('createStaffError');
    const fullName = document.getElementById('staffFullName').value.trim();
    const username = document.getElementById('staffUsername').value.trim();
    const password = document.getElementById('staffPassword').value;
    success.style.display = 'none';
    error.style.display = 'none';
    try {
        const response = await adminApiRequest('/api/admin/users', {
            method: 'POST',
            body: JSON.stringify({ fullName, username, password })
        });
        createStaffForm.reset();
        success.textContent = response.message || 'Staff account created.';
        success.style.display = 'block';
        await loadAdminUsers();
    } catch (requestError) {
        error.textContent = requestError.message || 'Could not create the staff account.';
        error.style.display = 'block';
    }
}

async function setUserStatus(userId, isActive) {
    try {
        await adminApiRequest(`/api/admin/users/${userId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ isActive })
        });
        await loadAdminUsers();
    } catch (error) {
        alert(error.message || 'Could not update the user account.');
    }
}

async function approveUser(userId) {
    if (!confirm('Approve this staff account and allow access to school records?')) {
        return;
    }
    try {
        await adminApiRequest(`/api/admin/users/${userId}/approve`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        await loadAdminUsers();
    } catch (error) {
        alert(error.message || 'Could not approve the user account.');
    }
}

async function rejectUser(userId) {
    if (!confirm('Reject this staff account request?')) {
        return;
    }
    try {
        await adminApiRequest(`/api/admin/users/${userId}/reject`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        await loadAdminUsers();
    } catch (error) {
        alert(error.message || 'Could not reject the user account.');
    }
}

function renderUsers() {
    const staffList = document.getElementById('staffUsersList');
    const allStaffUsers = usersCache.filter(user => user.role !== 'admin');
    const activeUsers = allStaffUsers.filter(user => user.status === 'active');
    const disabledUsers = allStaffUsers.filter(user => user.status === 'disabled');

    document.getElementById('activeUsersCard').textContent = String(activeUsers.length);
    document.getElementById('disabledUsersCard').textContent = String(disabledUsers.length);

    staffList.innerHTML = allStaffUsers.length
        ? allStaffUsers.map(user => `
            <div class="approval-card">
                <div>
                    <strong>${escapeHtml(user.fullName)}</strong>
                    <div class="approval-meta">User ID: ${escapeHtml(user.username)}</div>
                    <div class="approval-meta">Status: ${escapeHtml(formatAccountStatus(user.status))}</div>
                    <div class="approval-meta">Created: ${user.createdAt ? formatDate(user.createdAt) : '-'}</div>
                </div>
                <div class="approval-actions">
                    ${user.status === 'active' || user.status === 'disabled'
                        ? `<button class="btn ${user.status === 'active' ? 'btn-secondary' : 'btn-primary'} btn-compact" onclick="setUserStatus(${user.id}, ${user.status !== 'active'})">${user.status === 'active' ? 'Disable' : 'Activate'}</button>`
                        : ''}
                    <button class="btn btn-danger btn-compact" onclick="deleteUser(${user.id})">Delete</button>
                </div>
            </div>
        `).join('')
        : '<p class="empty-state">No staff accounts yet.</p>';
}

function formatAccountStatus(status) {
    const labels = { active: 'Active', disabled: 'Disabled', rejected: 'Rejected', pending: 'Inactive legacy account' };
    return labels[status] || String(status || 'Unknown');
}

function highlightRequestedUser() {
    const requestedReviewId = new URLSearchParams(window.location.search).get('review');
    if (!requestedReviewId) {
        return;
    }
    const match = [...document.querySelectorAll('[data-review-id]')]
        .find(element => element.dataset.reviewId === requestedReviewId);
    if (match) {
        match.classList.add('review-highlight');
        match.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

async function deleteUser(userId) {
    if (!confirm('Delete this user account?')) {
        return;
    }
    try {
        await adminApiRequest(`/api/admin/users/${userId}`, { method: 'DELETE' });
        await loadAdminUsers();
    } catch (error) {
        alert(error.message || 'Could not delete the user.');
    }
}

async function loadAdminRecords() {
    const tbody = document.getElementById('adminRecordsBody');
    tbody.innerHTML = '<tr><td colspan="13" style="text-align: center; color: #7c8199;">Loading records...</td></tr>';

    try {
        const response = await adminApiRequest('/api/records');
        adminRecordsCache = response.records || [];
        document.getElementById('adminStudentsCard').textContent = String(adminRecordsCache.length);
        populateReportYears(adminRecordsCache);
        renderAdminRecords(adminRecordsCache);
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; color: #b91c1c;">${escapeHtml(error.message || 'Could not load records.')}</td></tr>`;
    }
}

function renderAdminRecords(records) {
    const tbody = document.getElementById('adminRecordsBody');
    if (!records.length) {
        tbody.innerHTML = '<tr><td colspan="13" style="text-align: center; color: #7c8199;">No records found</td></tr>';
        return;
    }

    tbody.innerHTML = records.map(record => `
        <tr>
            <td>${escapeHtml(record.schoolName)}</td>
            <td>${escapeHtml(record.studentName)}</td>
            <td>${escapeHtml(record.rollNumber)}</td>
            <td>${escapeHtml(record.className)}</td>
            <td>${escapeHtml(record.parentName)}</td>
            <td>${escapeHtml(record.sessionYear)}</td>
            <td>${formatCurrency(getTotalAmount(record))}</td>
            <td>${formatCurrency(getAmountPaid(record))}</td>
            <td>${formatCurrency(getBalanceAmount(record))}</td>
            <td>${escapeHtml(formatPaymentMode(record.paymentMode))}</td>
            <td>${formatDate(new Date(record.dateAdded))}</td>
            <td>${escapeHtml(record.createdByName || 'Legacy import')}</td>
            <td><button class="btn-small btn-danger" onclick="deleteRecord(${record.id})">Delete</button></td>
        </tr>
    `).join('');
}

function filterAdminRecords() {
    const searchTerm = adminSearchInput.value.toLowerCase();
    const filtered = adminRecordsCache.filter(record =>
        String(record.schoolName || '').toLowerCase().includes(searchTerm) ||
        String(record.studentName || '').toLowerCase().includes(searchTerm) ||
        String(record.rollNumber || '').toLowerCase().includes(searchTerm) ||
        String(record.parentName || '').toLowerCase().includes(searchTerm)
    );
    renderAdminRecords(filtered);
}

async function deleteRecord(recordId) {
    if (!confirm('Delete this student record?')) {
        return;
    }
    try {
        await adminApiRequest(`/api/records/${recordId}`, { method: 'DELETE' });
        await loadAdminRecords();
    } catch (error) {
        alert(error.message || 'Could not delete the record.');
    }
}

async function deleteAllRecords() {
    if (!confirm('This will permanently delete all student records. Continue?')) {
        return;
    }
    try {
        await adminApiRequest('/api/records', { method: 'DELETE' });
        adminRecordsCache = [];
        renderAdminRecords(adminRecordsCache);
        document.getElementById('adminStudentsCard').textContent = '0';
    } catch (error) {
        alert(error.message || 'Could not delete all records.');
    }
}

async function exportRecords() {
    try {
        const payload = await adminApiRequest('/api/export');
        if (!payload.records || !payload.records.length) {
            alert('There are no records to export.');
            return;
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = `student-records-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(downloadUrl);
    } catch (error) {
        alert(error.message || 'Could not export records.');
    }
}

async function exportExcelRecords() {
    await downloadExcelExport({
        url: '/api/export.xlsx',
        buttonId: 'exportExcelBtn',
        busyLabel: 'Preparing Excel...',
        fallbackFilename: `student-records-${new Date().toISOString().slice(0, 10)}.xlsx`,
        errorMessage: 'Could not export Excel records.'
    });
}

async function exportHistoryExcel() {
    const sessionYear = reportSessionYearInput ? reportSessionYearInput.value.trim() : '';
    if (!sessionYear) {
        alert('Please select a session year first.');
        return;
    }
    const query = new URLSearchParams({ sessionYear });
    await downloadExcelExport({
        url: `/api/export-history.xlsx?${query.toString()}`,
        buttonId: 'exportHistoryExcelBtn',
        busyLabel: 'Preparing History Excel...',
        fallbackFilename: `student-history-${new Date().toISOString().slice(0, 10)}.xlsx`,
        errorMessage: 'Could not export the history Excel report.'
    });
}

async function downloadExcelExport({ url, buttonId, busyLabel, fallbackFilename, errorMessage }) {
    const button = document.getElementById(buttonId);
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                Authorization: `Bearer ${adminAuthToken}`
            }
        });
        if (!response.ok) {
            let data = {};
            try {
                data = await response.json();
            } catch (_error) {}
            if (response.status === 401) {
                adminAuthToken = '';
                sessionStorage.removeItem('adminAuthToken');
                adminLoginShell.style.display = 'flex';
                adminAppShell.style.display = 'none';
            }
            throw new Error(data.error || 'Could not create the Excel export.');
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
            throw new Error('The server returned an unexpected export format.');
        }
        const disposition = String(response.headers.get('content-disposition') || '');
        const filenameMatch = disposition.match(/filename="?([A-Za-z0-9._-]+)"?/i);
        const filename = filenameMatch ? filenameMatch[1] : fallbackFilename;
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (error) {
        alert(error.message || errorMessage);
    } finally {
        button.disabled = false;
        button.textContent = originalLabel;
    }
}

function populateReportYears(records) {
    if (!reportSessionYearInput) {
        return;
    }

    const previousValue = reportSessionYearInput.value;
    const sessionYears = [...new Set((records || [])
        .map(record => String(record.sessionYear || '').trim())
        .filter(Boolean))]
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    reportSessionYearInput.innerHTML = '<option value="">Select Session Year</option>' +
        sessionYears.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join('');

    if (sessionYears.includes(previousValue)) {
        reportSessionYearInput.value = previousValue;
    }
}

function exportHistoryReport() {
    const sessionYear = reportSessionYearInput ? reportSessionYearInput.value.trim() : '';
    if (!sessionYear) {
        alert('Please select a session year first.');
        return;
    }

    const reportRecords = adminRecordsCache
        .filter(record => String(record.sessionYear || '').trim() === sessionYear)
        .sort((a, b) => {
            const classCompare = String(a.className || '').localeCompare(String(b.className || ''), undefined, { numeric: true });
            if (classCompare !== 0) {
                return classCompare;
            }
            return String(a.studentName || '').localeCompare(String(b.studentName || ''));
        });

    if (!reportRecords.length) {
        alert('No records found for the selected session year.');
        return;
    }

    const totalStudents = reportRecords.length;
    const totalCollected = reportRecords.reduce((sum, record) => sum + getAmountPaid(record), 0);
    const totalFees = reportRecords.reduce((sum, record) => sum + getTotalAmount(record), 0);
    const totalBalance = reportRecords.reduce((sum, record) => sum + getBalanceAmount(record), 0);

    const reportWindow = window.open('', '_blank', 'width=1200,height=900');
    if (!reportWindow) {
        alert('Please allow pop-ups to export the history report.');
        return;
    }

    const rowsHtml = reportRecords.map((record, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${escapeHtml(record.studentName)}</td>
            <td>${escapeHtml(record.className)}</td>
            <td>${escapeHtml(record.parentName)}</td>
            <td>${escapeHtml(record.contactNumber)}</td>
            <td>${formatCurrency(getTotalAmount(record))}</td>
            <td>${formatCurrency(getAmountPaid(record))}</td>
            <td>${formatCurrency(getBalanceAmount(record))}</td>
            <td>${formatDate(record.admissionDate)}</td>
        </tr>
    `).join('');

    reportWindow.document.open();
    reportWindow.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>History Report - ${escapeHtml(sessionYear)}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }
        h1 { margin: 0 0 6px; font-size: 22px; }
        p { margin: 4px 0; }
        .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
        .card { border: 1px solid #cbd5e1; border-radius: 12px; padding: 12px; background: #f8fafc; }
        .label { font-size: 12px; text-transform: uppercase; color: #475569; margin-bottom: 6px; }
        .value { font-size: 20px; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; margin-top: 18px; }
        th, td { border: 1px solid #cbd5e1; padding: 8px 10px; font-size: 13px; text-align: left; }
        th { background: #e2e8f0; }
        td:nth-child(6), td:nth-child(7), td:nth-child(8), th:nth-child(6), th:nth-child(7), th:nth-child(8) { text-align: right; }
        .footer-note { margin-top: 16px; font-size: 12px; color: #64748b; }
        @media print { body { margin: 12mm; } }
    </style>
</head>
<body>
    <h1>${escapeHtml('Phoenix English, Marathi Primary, Secondary, and Junior College, Mahud B.K, Tal- Sangola, Dist- Solapur.')}</h1>
    <p><strong>Student History Report</strong></p>
    <p>Session Year: <strong>${escapeHtml(sessionYear)}</strong></p>
    <p>Generated On: <strong>${formatDate(new Date())}</strong></p>
    <div class="summary">
        <div class="card"><div class="label">Total Students</div><div class="value">${totalStudents}</div></div>
        <div class="card"><div class="label">Total Fees</div><div class="value">${escapeHtml(formatCurrency(totalFees))}</div></div>
        <div class="card"><div class="label">Amount Collected</div><div class="value">${escapeHtml(formatCurrency(totalCollected))}</div></div>
        <div class="card"><div class="label">Balance Due</div><div class="value">${escapeHtml(formatCurrency(totalBalance))}</div></div>
    </div>
    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>Student Name</th>
                <th>Class</th>
                <th>Parent Name</th>
                <th>Contact</th>
                <th>Total Fees</th>
                <th>Paid</th>
                <th>Balance</th>
                <th>Admission Date</th>
            </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
    </table>
    <p class="footer-note">Choose Print and then Save as PDF to store this report as a PDF file.</p>
    <script>window.onload = function () { window.print(); };</script>
</body>
</html>`);
    reportWindow.document.close();
}

async function importRecords(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    if (!confirm('Restore this backup? All current student records will be replaced by the records in this file.')) {
        importRecordsInput.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = async function (loadEvent) {
        try {
            const parsed = JSON.parse(loadEvent.target.result);
            await adminApiRequest('/api/import', {
                method: 'POST',
                body: JSON.stringify(parsed)
            });
            await loadAdminRecords();
            alert('Backup restored successfully.');
        } catch (error) {
            alert(error.message || 'Could not import records. Please choose a valid backup file.');
        } finally {
            importRecordsInput.value = '';
        }
    };
    reader.readAsText(file);
}

async function uploadBackground() {
    const fileInput = document.getElementById('bgUpload');
    const file = fileInput.files[0];

    if (!file) {
        alert('Please select an image file.');
        return;
    }

    if (!file.type.startsWith('image/')) {
        alert('Please choose a valid image file.');
        return;
    }

    if (file.size > 6 * 1024 * 1024) {
        alert('Please choose an image smaller than 6 MB.');
        return;
    }

    const reader = new FileReader();
    reader.onload = async function (event) {
        try {
            const response = await adminApiRequest('/api/settings/background', {
                method: 'PUT',
                body: JSON.stringify({ backgroundImage: event.target.result })
            });
            applyStoredBackground(response.backgroundImage || '');
            alert('Background saved.');
        } catch (error) {
            alert(error.message || 'Could not save the background.');
        }
    };

    reader.readAsDataURL(file);
}

async function resetBackground() {
    try {
        await adminApiRequest('/api/settings/background', {
            method: 'PUT',
            body: JSON.stringify({ backgroundImage: '' })
        });
        applyStoredBackground('');
        document.getElementById('bgUpload').value = '';
        alert('Background reset.');
    } catch (error) {
        alert(error.message || 'Could not reset the background.');
    }
}

function applyStoredBackground(imageData) {
    const preview = document.getElementById('bgPreview');
    if (imageData) {
        document.body.style.backgroundImage = `url('${imageData}')`;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundAttachment = 'fixed';
        document.body.style.backgroundPosition = 'center';
        preview.src = imageData;
        preview.style.display = 'block';
    } else {
        document.body.style.backgroundImage = 'none';
        document.body.style.background = 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)';
        preview.style.display = 'none';
    }
}

function updateAdminOfflineBanner() {
    if (navigator.onLine) {
        adminOfflineBanner.textContent = 'Connected to the cloud school database.';
        adminOfflineBanner.classList.remove('is-offline');
    } else {
        adminOfflineBanner.textContent = 'No network connection. Reconnect before managing records or accounts.';
        adminOfflineBanner.classList.add('is-offline');
    }
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

function escapeHtml(text) {
    if (!text) {
        return '';
    }
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, match => map[match]);
}

async function adminApiRequest(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (options.useAuth !== false && adminAuthToken) {
        headers.Authorization = `Bearer ${adminAuthToken}`;
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
            adminAuthToken = '';
            sessionStorage.removeItem('adminAuthToken');
            adminLoginShell.style.display = 'flex';
            adminAppShell.style.display = 'none';
        }
        throw new Error(data.error || 'Request failed.');
    }
    return data;
}

window.addEventListener('load', async function () {
    localStorage.removeItem('adminAuthToken');
    updateAdminOfflineBanner();

    if (!adminAuthToken) {
        adminLoginShell.style.display = 'flex';
        adminAppShell.style.display = 'none';
        return;
    }

    try {
        const response = await adminApiRequest('/api/session');
        if (response.user.role !== 'admin') {
            sessionStorage.removeItem('adminAuthToken');
            window.location.href = 'index.html';
            return;
        }
        adminCurrentUser = response.user;
        applyStoredBackground(response.settings.backgroundImage || '');
        await initializeAdminApp();
    } catch (error) {
        adminAuthToken = '';
        sessionStorage.removeItem('adminAuthToken');
        adminLoginShell.style.display = 'flex';
        adminAppShell.style.display = 'none';
    }
});

window.setInterval(async function () {
    if (!adminAuthToken || !adminCurrentUser || document.visibilityState !== 'visible') {
        return;
    }
    try {
        await loadAdminUsers();
    } catch (error) {
        // The next poll or an explicit action will retry.
    }
}, 30000);

window.addEventListener('online', updateAdminOfflineBanner);
window.addEventListener('offline', updateAdminOfflineBanner);
