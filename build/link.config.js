// Bauplan fuer den eigenen Installer "Glowline Link" (Laptop-App): gleicher Code wie Glowline,
// aber mit eigener App-ID, eigenem Namen, eigenem Einstellungsordner und Schalter glowlineLink
const basis = require('../package.json').build;

module.exports = {
  ...basis,
  appId: 'com.glowline.link',
  productName: 'Glowline Link',
  extraMetadata: { glowlineLink: true, productName: 'Glowline Link', name: 'glowline-link', description: 'Use the AI models of your Glowline PC from your laptop' },
  directories: { ...basis.directories, output: 'dist-link' },
  files: basis.files,
  win: { ...basis.win, artifactName: 'Glowline-Link-Setup-${version}.${ext}' },
  nsis: { ...basis.nsis, shortcutName: 'Glowline Link', guid: 'b7a3c1e2-5f4d-4c8a-9e61-2d7f0a3b9c54' },
};
