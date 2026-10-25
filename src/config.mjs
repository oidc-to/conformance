import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const secretMethods = ["client_secret_basic", "client_secret_post", "client_secret_jwt"];

const responseTypes = ["code", "id_token", "id_token token", "code id_token", "code token", "code id_token token"];

// conformance.config.mjs in the working directory, or the file given; none is fine.
export async function loadConfig(path) {
  const file = path
    ? resolve(path)
    : ["conformance.config.mjs", "conformance.config.js"].map((name) => resolve(name)).find(existsSync);
  if (!file) return {};
  if (!existsSync(file)) throw new Error(`no config at ${file}`);
  const module = await import(pathToFileURL(file).href);
  return module.default ?? {};
}

// A config field is a value or a function of the run's context.
function value(field, context) {
  return typeof field === "function" ? field(context) : field;
}

function signingKey(kid) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...privateKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };
}

export class Clients {
  constructor() {
    this.keys = new Map();
  }

  // The private key the suite signs with as this client, the same for every variant of a run.
  key(name) {
    if (!this.keys.has(name)) this.keys.set(name, signingKey(name));
    return this.keys.get(name);
  }

  // A client registered at the OP's registration_endpoint.
  async register({ name, method, discovery, alias, callback, key = this.key(name) }) {
    if (!discovery.registration_endpoint) {
      throw new Error("the OP has no registration_endpoint; give the config a client function");
    }
    const { d: _, ...publicKey } = key;
    const response = await fetch(discovery.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: `${alias} ${name}`,
        redirect_uris: [callback],
        response_types: responseTypes,
        grant_types: ["authorization_code", "implicit", "refresh_token"],
        token_endpoint_auth_method: method,
        jwks: { keys: [publicKey] },
      }),
    });
    const text = await response.text();
    if (response.status !== 201) {
      throw new Error(`registering ${name} for ${method} failed: ${response.status} ${text}`);
    }
    const registered = JSON.parse(text);
    return {
      client_id: registered.client_id,
      ...(registered.client_secret && { client_secret: registered.client_secret }),
      client_secret_jwt_alg: "HS256",
      client_name: registered.client_name ?? `${alias} ${name}`,
      jwks: { keys: [key] },
    };
  }
}

// The suite's JSON config for one variant of a plan.
export async function suiteConfig({ config, clients, issuer, suite, discovery, variant, remote, rendering }) {
  const alias = config.alias ?? "conformance";
  const context = {
    issuer,
    suite,
    alias,
    discovery,
    remote,
    variant,
    callback: `${suite}/test/a/${alias}/callback`,
    // Appended to a browser "wait" command, it fills a screenshot slot with the page source when
    // nothing renders screenshots.
    placeholder: rendering ? [] : ["update-image-placeholder-optional"],
  };
  // Plans without a client_auth_type variant, like the basic certification plan, use client_secret_basic.
  const method = variant.client_auth_type ?? "client_secret_basic";
  const client = async (name, method) => {
    const clientContext = {
      ...context,
      name,
      method,
      secret: secretMethods.includes(method),
      key: clients.key(name),
      register: (overrides = {}) => clients.register({ ...context, name, method, ...overrides }),
    };
    return (await config.client?.(clientContext)) ?? clientContext.register();
  };
  return {
    alias,
    description: value(config.description, context) ?? `${issuer}`,
    // server_metadata=static reads from here what discovery would have said.
    server:
      variant.server_metadata === "static"
        ? {
            issuer: discovery.issuer,
            jwks_uri: discovery.jwks_uri,
            authorization_endpoint: discovery.authorization_endpoint,
            token_endpoint: discovery.token_endpoint,
            userinfo_endpoint: discovery.userinfo_endpoint,
            registration_endpoint: discovery.registration_endpoint,
            acr_values: discovery.acr_values_supported?.join(" "),
          }
        : { discoveryUrl: `${issuer}/.well-known/openid-configuration` },
    client: await client("client", method),
    client2: await client("client2", method),
    // oidcc-server-client-secret-post uses this instead of client.
    client_secret_post: await client("client", "client_secret_post"),
    browser: value(config.browser, context) ?? [],
    override: value(config.override, context) ?? {},
  };
}

export async function writeSuiteConfig(work, index, options) {
  const file = join(work, `config-${index}.json`);
  writeFileSync(file, JSON.stringify(await suiteConfig(options), null, 2));
  return file;
}
