# conformance

Runs an [OpenID Foundation conformance suite](https://gitlab.com/openid/conformance-suite) test plan against an OpenID Provider, with every variant of the plan, and writes a module × variant table of the results. You can run it from a terminal or in GitHub Actions.

The package is published to GitHub Packages, which wants a token even for reads. In `.npmrc`:

```ini
@oidc-to:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
NODE_AUTH_TOKEN=$(gh auth token) npm install --save-dev @oidc-to/conformance
```

Locally, use any token with `read:packages`. In Actions, set `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` with `permissions: packages: read`; that token can read the package only if the package grants the workflow's repository access, or the package is public.

```jsonc
// package.json
"scripts": {
  "conformance": "oidc-conformance"
}
```

```sh
npm run conformance -- https://op.example.com   # an OP that is already running
npm run conformance -- npm run dev              # a command that starts the OP
```

It needs Docker, Python 3, `curl` and Node 22 or later.

## What a run does

1. Downloads the suite's prebuilt compose file and its `run-test-plan.py` runner at the pinned release (`CONFORMANCE_IMAGE_TAG`, default `release-v5.3.3`), then installs the runner's requirements into a venv under `.conformance/`.
2. Gives the suite a public https address through [tunneld](https://tunnel.pizza) and starts it with that address as its base URL. The OP has to fetch the `request_uri`, `sector_identifier_uri` and `jwks_uri` documents the suite hosts, so the suite has to be reachable from wherever the OP runs.
3. Asks for a plan, its variants and its modules when it's run in a terminal. Otherwise it reads them from `--plan`, `--variant` and `--modules`, or from `CONFORMANCE_PLAN`, `CONFORMANCE_VARIANT` and `CONFORMANCE_MODULES`. The plan defaults to `oidcc-test-plan`. A plan expands to every combination of its variant values, except the mTLS ones.
4. Starts the OP if you gave it a command. The issuer is the first `https://` origin the command prints on stdout. That's what `tunneld` prints, and `tunneld` also sets `HTTP_ORIGIN` for the program it starts. Pass `--issuer` if the command prints nothing.
5. Writes a suite config for each variant, then runs them one after another with `run-test-plan.py`.
6. Writes `.conformance/results/summary.md` and `summary.json` and keeps them updated while the run is in progress. When `GITHUB_STEP_SUMMARY` is set it appends the summary there, and it prints the table at the end.
7. Takes down the suite and the OP when it finishes or gets a signal.

It exits 0 when every plan ran, however many modules failed.

`REVIEW` modules ask for screenshots. Playwright's Chromium renders the page the suite's browser was served and uploads the image. If Chromium can't start, the suite saves the page source instead.

## Configuration

`conformance.config.mjs` in the working directory, or the file passed with `--config`, holds what the runner can't know about your OP. Every field is optional. A field can be a value or a function of the run's context, and the default export can also be a function of `{ remote }`, where `remote` is true when the target is an issuer URL rather than a command.

```js
export default ({ remote }) => ({
  // Starts the OP when the command line gives no issuer or command: a string runs in the shell,
  // an array is argv. Plain `npm run conformance` then runs it, and `npm run conformance -- --plan x`
  // and `npm run conformance -- https://op.example.com` still work.
  command: "npm run dev",

  // The suite's alias for this OP; redirect URIs are `${suite}/test/a/${alias}/callback`.
  alias: "my-op",

  // The suite's client, client2 and client_secret_post entries. Without this, each one is
  // registered at the OP's registration_endpoint with a fresh EC P-256 key.
  client: ({ name, method, secret, key, callback, issuer, register }) =>
    secret ? register() : { client_id: `${issuer}/clients/${name}`, jwks: { keys: [key] } },

  // Browser automation for signing in. Without it every module waits for a person, until the
  // runner gives up after 240s.
  browser: ({ issuer, discovery, callback, placeholder }) => [
    {
      match: `${discovery.authorization_endpoint}*`,
      tasks: [
        {
          task: "Sign in",
          match: `${issuer}/login*`,
          commands: [
            ["wait", "id", "submit", 10, ...placeholder],
            ["click", "id", "submit"],
          ],
        },
        { task: "Verify Complete", match: `${callback}*`, commands: [["wait", "id", "submission_complete", 10]] },
      ],
    },
  ],

  // Per-module config overrides, as the suite's config file takes them.
  override: {},

  // oidcc-server-rotate-keys waits for the OP to rotate its signing key. This does it; the runner
  // then polls jwks_uri until it changes. Without it, the module is skipped.
  rotateKeys: remote ? undefined : async ({ issuer, discovery }) => {},
});
```

The context includes:

| field | |
| --- | --- |
| `issuer` | the OP's issuer |
| `discovery` | its `/.well-known/openid-configuration` |
| `suite` | the suite's public base URL |
| `alias`, `callback` | the alias and the suite's redirect URI for it |
| `variant` | the variant this config is for |
| `remote` | the target was an issuer URL, not a command |
| `placeholder` | add it to a `wait` command that should fill a screenshot slot with the page source when Chromium isn't available |
| `name`, `method`, `secret`, `key`, `register` | in `client`: which client, its `token_endpoint_auth_method`, whether that method uses a secret, its private key, and `register(overrides)` for dynamic registration |

## GitHub Actions

### One job

```yaml
- uses: actions/checkout@v7
- uses: oidc-to/conformance@main
  with:
    issuer: https://op.example.com
    # plan, variant, modules, config, image-tag, working-directory, cache
- uses: actions/upload-artifact@v7
  if: always()
  with:
    name: conformance
    path: |
      .conformance/results
      !.conformance/results/*.zip
```

The variants run one after another, so a plan with many variants needs a long `timeout-minutes`.

With `cache` (the default), the action keeps the suite's images, its plan catalogue, pip's downloads and Playwright's browser in GitHub's cache, one entry per suite release and package version. The first run fills it. The CLI reads and writes the same files in the directory named by `CONFORMANCE_CACHE`. Without it, nothing is cached.

### Against a deployed oidc.to

This repository's [Conformance](.github/workflows/conformance.yml) workflow runs `oidcc-test-plan` against the issuer you give it, one job per variant, and merges the results into one table. Start it from the Actions tab or with:

```sh
gh workflow run conformance.yml -R oidc-to/conformance -f issuer=https://oidc.to.scaffoldly.dev -f max_parallel=2
```

The variants job fills the cache when it is cold, so every matrix job loads the images from it and none pulls them. It uses [`configs/oidc.to.mjs`](configs/oidc.to.mjs), which has oidc.to's sign-in automation and no keys. Every client is registered dynamically, and `oidcc-server-rotate-keys` is skipped. `max_parallel` is how many jobs the variants are split across, and so how many run at once and how many suite tunnels a run opens; without it, the `CONFORMANCE_MAX_PARALLEL` repository variable sets it, else 10. Each job runs its share one after another. `0` or `1` runs them all in a single job, which can take up to its 6-hour limit. The uploaded artifacts leave out the suite's exported plans, because those contain client secrets and private keys.

The runner retries its own requests to the OP (discovery, registration, the JWKS) when they get a 429 or 503, after the Retry-After. The suite's requests during a module are not retried, so a throttled OP fails that module; lower `max_parallel` instead.

## Commands

```text
oidc-conformance [options] <issuer>
oidc-conformance [options] <command...>
oidc-conformance [options]                          # the config's command
oidc-conformance variants [--plan] [--variant] [--jobs n]  # JSON matrix in n jobs; sets the matrix output in Actions
oidc-conformance merge [--out dir] <summary.json...>
```

## Security

- While a run is in progress, anyone who has the suite's tunnel address can reach the suite. The address is random and goes away when the run ends.
- `.conformance/results` holds the suite's exported plans. Those include the client configs, with their secrets and private keys. Don't upload them anywhere public.

## License

[MIT](LICENSE)
