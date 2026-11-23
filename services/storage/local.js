const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../../uploads/transfers');

module.exports = {
  name: 'local',

  async save(storageKey, buffer, mimeType, onProgress) {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, storageKey), buffer);
    onProgress?.(buffer.length);
  },

  async read(storageKey) {
    return fs.createReadStream(path.join(dir, storageKey));
  },

  async remove(storageKey) {
    await fs.promises.unlink(path.join(dir, storageKey)).catch(() => {});
  },
};
