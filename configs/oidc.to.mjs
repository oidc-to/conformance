// oidc.to's sign-in pages, for a deployed oidc.to given only by its URL. Every client is
// registered at its registration_endpoint, so no client keys live here.

// These expect an error page on the issuer, not a redirect back to the suite.
const errorPageModules = [
  "oidcc-ensure-registered-redirect-uri",
  "oidcc-ensure-redirect-uri-in-authorization-request",
  "oidcc-redirect-uri-query-added",
  "oidcc-redirect-uri-query-mismatch",
];

export default {
  alias: "oidc-to",
  description: ({ issuer }) => `oidc.to at ${issuer}`,

  browser: ({ issuer, discovery, callback, placeholder }) => [
    {
      match: `${discovery.authorization_endpoint}*`,
      tasks: [
        {
          task: "Continue",
          match: `${issuer}/oauth/continue*`,
          optional: true,
          commands: [
            ["wait", "xpath", "//*", 10, "Continue to sign in", ...placeholder],
            ["click", "id", "submit"],
          ],
        },
        {
          task: "Verify Complete",
          match: `${callback}*`,
          commands: [["wait", "id", "submission_complete", 10]],
        },
      ],
    },
  ],

  override: ({ issuer, discovery, placeholder }) =>
    Object.fromEntries(
      errorPageModules.map((module) => [
        module,
        {
          browser: [
            {
              match: `${discovery.authorization_endpoint}*`,
              tasks: [
                {
                  task: "Expect an error page",
                  match: `${issuer}/oauth/error*`,
                  commands: [["wait", "xpath", "//*", 10, "redirect_uri", ...placeholder]],
                },
              ],
            },
          ],
        },
      ]),
    ),
};
