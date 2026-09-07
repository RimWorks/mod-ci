export default {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    // no npm plugin: consumers install straight from the git tag, so nothing is published
    // and nothing has to be committed back to main
    '@semantic-release/github',
  ],
};
