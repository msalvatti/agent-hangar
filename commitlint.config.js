/**
 * commitlint configuration: Conventional Commits with a 100-character header cap.
 *
 * Layer: config.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 200],
  },
};
