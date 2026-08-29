'use strict';

const { startApplication } = require('./src/application');

startApplication()
    .then((application) => application.installSignalHandlers())
    .catch((error) => {
        console.error('Application startup failed:', error.message);
        process.exit(1);
    });
