// Runs before any test module loads (including their imports).
// Strips GitHub Actions runtime env vars so @actions/github's Context
// constructor doesn't try to fs.existsSync(GITHUB_EVENT_PATH) at module
// load time — that read crashes when fs is jest-mocked because the mock
// const is still in TDZ during hoisted module init.
delete process.env.GITHUB_EVENT_PATH;
delete process.env.GITHUB_EVENT_NAME;
delete process.env.GITHUB_REPOSITORY;
delete process.env.GITHUB_REF;
delete process.env.GITHUB_SHA;
delete process.env.GITHUB_ACTIONS;
