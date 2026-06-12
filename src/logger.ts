import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const consoleFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}][${service ?? 'app'}][${level.toUpperCase()}] ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(winston.format.timestamp(), winston.format.json());

export function createLogger(service: string): winston.Logger {
  return winston.createLogger({
    level: 'info',
    defaultMeta: { service },
    transports: [
      new winston.transports.Console({ format: consoleFormat }),
      new DailyRotateFile({
        filename: 'logs/app-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        format: fileFormat,
      }),
    ],
  });
}
