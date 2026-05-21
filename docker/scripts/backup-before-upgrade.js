const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = process.env.NAV_DATA_DIR
    ? path.resolve(process.env.NAV_DATA_DIR)
    : path.join(root, 'data');
const uploadsDir = process.env.NAV_UPLOADS_DIR
    ? path.resolve(process.env.NAV_UPLOADS_DIR)
    : path.join(root, 'uploads');
const backupRoot = process.env.NAV_BACKUP_DIR
    ? path.resolve(process.env.NAV_BACKUP_DIR)
    : path.join(root, 'upgrade-backups');

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function copyRecursive(source, destination) {
    if (!fs.existsSync(source)) {
        return false;
    }

    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            copyRecursive(path.join(source, entry), path.join(destination, entry));
        }
        return true;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
}

const backupDir = path.join(backupRoot, `backup-${timestamp()}`);
fs.mkdirSync(backupDir, { recursive: true });

const copied = [];
if (copyRecursive(dataDir, path.join(backupDir, 'data'))) {
    copied.push(dataDir);
}
if (copyRecursive(uploadsDir, path.join(backupDir, 'uploads'))) {
    copied.push(uploadsDir);
}

if (copied.length === 0) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    console.error('No data or uploads directory found. Run this script from the docker directory after the app has created persistent data.');
    process.exit(1);
}

console.log(`Backup created: ${backupDir}`);
for (const item of copied) {
    console.log(`Copied: ${item}`);
}
