const colors = require('ansi-colors');
const { basename } = require('node:path');

class CustomReporter {
  constructor() {
    this.fileResults = [];
  }

  onTestResult(testContext, testResult) {
    let totalDuration = 0;
    let fileEntry = this.fileResults.find((entry) => entry.file === basename(testContext.path));
    if (!fileEntry) {
      fileEntry = { duration: 0, file: basename(testContext.path), tests: [] };
      this.fileResults.push(fileEntry);
    }
    testResult.testResults.forEach((result) => {
      fileEntry.tests.push({
        duration: result.duration || 0,
        status: result.status,
        title: result.fullName,
      });
      totalDuration += result.duration;
    });
    fileEntry.duration = totalDuration;
  }

  onRunComplete() {
    console.debug('--------------------------------------------------------');
    console.debug(`\n ${colors.cyan('Test Cases Overview:')}`);

    const config = {
      failed: { statusColor: colors.red, statusSymbol: '✘', titleDisplay: (title) => colors.bgRed(title) },
      passed: { statusColor: colors.green, statusSymbol: '✔', titleDisplay: (title) => title },
      pending: { statusColor: colors.yellow, statusSymbol: '⚠', titleDisplay: (title) => colors.bgYellow(title) },
    };

    this.fileResults.forEach(({ duration, file, tests }) => {
      console.debug(colors.blue(`\nTest Suite: ${file} - ${duration}ms`));
      tests.forEach((test) => {
        const { statusColor, statusSymbol, titleDisplay } = config[test.status];
        console.debug(
          ` ${statusColor(statusSymbol)} ${titleDisplay(test.title)} ${colors.dim(`(${test.duration}ms)`)}`,
        );
      });
    });
  }
}

module.exports = CustomReporter;
