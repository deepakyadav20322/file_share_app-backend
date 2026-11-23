const mongoose = require('mongoose');

// One document (key: 'app') holding the runtime options changed from the admin panel.
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Setting', settingSchema);
