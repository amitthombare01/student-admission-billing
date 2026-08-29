'use strict';

const ExcelJS = require('exceljs');
const { PassThrough } = require('node:stream');

const MONEY_FORMAT = '"Rs "#,##0.00';
const MAX_CELL_CHARACTERS = 32767;

async function createStudentRecordsWorkbook(records, exportedAt = new Date()) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const completed = new Promise((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
    });
    await writeStudentRecordsWorkbook(records, stream, exportedAt);
    await completed;
    return Buffer.concat(chunks);
}

async function writeStudentRecordsWorkbook(records, outputStream, exportedAt = new Date()) {
    const workbook = createWorkbookWriter(outputStream, exportedAt, {
        title: 'Student Admission Records',
        subject: 'Administrator export of student admission and billing records'
    });
    addStudentRecordsWorksheet(workbook, records, 'Student Records');
    await workbook.commit();
}

async function writeSessionHistoryWorkbook(records, outputStream, sessionYear, exportedAt = new Date()) {
    const workbook = createWorkbookWriter(outputStream, exportedAt, {
        title: 'Session Year Student History',
        subject: 'Administrator export of a session year student history report'
    });
    const summary = summarizeRecords(records);
    addHistorySummaryWorksheet(workbook, sessionYear, exportedAt, summary);
    addStudentRecordsWorksheet(workbook, records, 'Student History');
    await workbook.commit();
    return summary;
}

function createWorkbookWriter(outputStream, exportedAt, metadata) {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: outputStream,
        useStyles: true,
        useSharedStrings: false
    });
    workbook.creator = 'Student Admission Billing System';
    workbook.lastModifiedBy = 'Student Admission Billing System';
    workbook.created = exportedAt;
    workbook.modified = exportedAt;
    workbook.title = metadata.title;
    workbook.subject = metadata.subject;
    workbook.company = 'School Administration';
    return workbook;
}

function addHistorySummaryWorksheet(workbook, sessionYear, exportedAt, summary) {
    const worksheet = workbook.addWorksheet('Summary', {
        properties: { defaultRowHeight: 20 },
        pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 }
    });
    worksheet.columns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Value', key: 'value', width: 42 }
    ];

    const header = worksheet.getRow(1);
    styleHeaderRow(header);
    header.commit();

    const rows = [
        ['Report', 'Student History Report'],
        ['Session Year', safeExcelText(sessionYear)],
        ['Generated At (UTC)', exportedAt],
        ['Total Students', summary.totalStudents],
        ['Total Fees', summary.totalFees],
        ['Amount Collected', summary.totalCollected],
        ['Balance Due', summary.totalBalance]
    ];
    for (const [metric, value] of rows) {
        const row = worksheet.addRow({ metric, value });
        row.getCell(1).font = { bold: true };
        if (metric === 'Generated At (UTC)') row.getCell(2).numFmt = 'yyyy-mm-dd hh:mm:ss';
        if (['Total Fees', 'Amount Collected', 'Balance Due'].includes(metric)) row.getCell(2).numFmt = MONEY_FORMAT;
        row.commit();
    }
    worksheet.commit();
}

function addStudentRecordsWorksheet(workbook, records, worksheetName) {

    const worksheet = workbook.addWorksheet(worksheetName, {
        properties: { defaultRowHeight: 18 },
        views: [{ state: 'frozen', ySplit: 1 }],
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });

    worksheet.columns = [
        { header: 'Record ID', key: 'id', width: 12 },
        { header: 'School', key: 'schoolName', width: 34 },
        { header: 'Student', key: 'studentName', width: 24 },
        { header: 'Roll Number', key: 'rollNumber', width: 16 },
        { header: 'Class', key: 'className', width: 12 },
        { header: 'Parent / Guardian', key: 'parentName', width: 24 },
        { header: 'Contact', key: 'contactNumber', width: 18 },
        { header: 'Email', key: 'emailAddress', width: 28 },
        { header: 'Date of Birth', key: 'dateOfBirth', width: 16 },
        { header: 'Address', key: 'address', width: 38 },
        { header: 'Tuition Fee', key: 'tuitionFee', width: 16, style: { numFmt: MONEY_FORMAT } },
        { header: 'Transport Fee', key: 'transportFee', width: 16, style: { numFmt: MONEY_FORMAT } },
        { header: 'Sports Fee', key: 'sportsFee', width: 16, style: { numFmt: MONEY_FORMAT } },
        { header: 'Other Fee', key: 'otherFee', width: 16, style: { numFmt: MONEY_FORMAT } },
        { header: 'Total Fee', key: 'totalFee', width: 16, style: { numFmt: MONEY_FORMAT } },
        { header: 'Amount Paid', key: 'amountPaid', width: 16, style: { numFmt: MONEY_FORMAT } },
        { header: 'Balance', key: 'balance', width: 16, style: { numFmt: MONEY_FORMAT } },
        { header: 'Payment Mode', key: 'paymentMode', width: 16 },
        { header: 'Session Year', key: 'sessionYear', width: 16 },
        { header: 'Admission Date', key: 'admissionDate', width: 16 },
        { header: 'Created At (UTC)', key: 'dateAdded', width: 22 }
    ];

    worksheet.autoFilter = { from: 'A1', to: 'U1' };
    worksheet.getColumn('dateOfBirth').numFmt = 'yyyy-mm-dd';
    worksheet.getColumn('admissionDate').numFmt = 'yyyy-mm-dd';
    worksheet.getColumn('dateAdded').numFmt = 'yyyy-mm-dd hh:mm:ss';
    worksheet.getColumn('schoolName').alignment = { vertical: 'top', wrapText: true };
    worksheet.getColumn('address').alignment = { vertical: 'top', wrapText: true };

    const header = worksheet.getRow(1);
    header.height = 24;
    styleHeaderRow(header);
    header.commit();

    for (const record of records) {
        const tuitionFee = roundMoney(record.tuitionFee);
        const transportFee = roundMoney(record.transportFee);
        const sportsFee = roundMoney(record.sportsFee);
        const otherFee = roundMoney(record.otherFee);
        const amountPaid = roundMoney(record.amountPaid);
        const totalFee = roundMoney(tuitionFee + transportFee + sportsFee + otherFee);
        const row = worksheet.addRow({
            id: Number(record.id),
            schoolName: safeExcelText(record.schoolName),
            studentName: safeExcelText(record.studentName),
            rollNumber: safeExcelText(record.rollNumber),
            className: safeExcelText(record.className),
            parentName: safeExcelText(record.parentName),
            contactNumber: safeExcelText(record.contactNumber),
            emailAddress: safeExcelText(record.emailAddress),
            dateOfBirth: dateOnlyToUtcDate(record.dateOfBirth),
            address: safeExcelText(record.address),
            tuitionFee,
            transportFee,
            sportsFee,
            otherFee,
            totalFee,
            amountPaid,
            balance: roundMoney(totalFee - amountPaid),
            paymentMode: safeExcelText(record.paymentMode),
            sessionYear: safeExcelText(record.sessionYear),
            admissionDate: dateOnlyToUtcDate(record.admissionDate),
            dateAdded: timestampToDate(record.dateAdded)
        });
        if (row.number % 2 === 1) {
            row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FB' } };
        }
        row.commit();
    }
    worksheet.commit();
}

function styleHeaderRow(header) {
    header.height = 24;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    header.eachCell((cell) => {
        cell.border = {
            bottom: { style: 'thin', color: { argb: 'FF9FB3C8' } }
        };
    });
}

function summarizeRecords(records) {
    let totalFees = 0;
    let totalCollected = 0;
    for (const record of records) {
        totalFees += roundMoney(record.tuitionFee) + roundMoney(record.transportFee) +
            roundMoney(record.sportsFee) + roundMoney(record.otherFee);
        totalCollected += roundMoney(record.amountPaid);
    }
    totalFees = roundMoney(totalFees);
    totalCollected = roundMoney(totalCollected);
    return {
        totalStudents: records.length,
        totalFees,
        totalCollected,
        totalBalance: roundMoney(totalFees - totalCollected)
    };
}

function safeExcelText(value) {
    let text = String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
        .slice(0, MAX_CELL_CHARACTERS);
    if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = `'${text}`;
    return text;
}

function dateOnlyToUtcDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function timestampToDate(value) {
    const date = value instanceof Date ? value : new Date(value || '');
    return Number.isNaN(date.getTime()) ? null : date;
}

function roundMoney(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

module.exports = {
    createStudentRecordsWorkbook,
    safeExcelText,
    summarizeRecords,
    writeSessionHistoryWorkbook,
    writeStudentRecordsWorkbook
};
