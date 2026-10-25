import { autocompleteMultiselect, cancel, intro, isCancel, multiselect, select } from "@clack/prompts";

export const defaultPlan = "oidcc-test-plan";
export const rotateKeys = "oidcc-server-rotate-keys";

// Every combination of the chosen values, one per axis.
export function combinations(chosen) {
  return Object.entries(chosen).reduce(
    (runs, [axis, values]) => runs.flatMap((run) => values.map((value) => ({ ...run, [axis]: value }))),
    [{}],
  );
}

// mTLS never reaches an OP behind a TLS-terminating proxy or tunnel.
const mtlsValues = ["mtls", "tls_client_auth", "self_signed_tls_client_auth"];

// A variant axis's values, without the mTLS ones.
function variantValuesOf({ variantValues }) {
  return Object.keys(variantValues).filter((value) => !mtlsValues.includes(value));
}

// Every variant of a plan as /api/plan/available lists it, without mTLS.
export function everyVariant({ variants }) {
  return combinations(
    Object.fromEntries(Object.entries(variants).map(([axis, variant]) => [axis, variantValuesOf(variant)])),
  );
}

// "axis=value,axis=value", as CONFORMANCE_VARIANT and --variant take it.
export function parseVariant(text = "") {
  return Object.fromEntries(
    text
      .split(",")
      .filter(Boolean)
      .map((pair) => pair.split("=").map((part) => part.trim())),
  );
}

export function formatVariant(variant) {
  return Object.entries(variant)
    .map(([axis, value]) => `${axis}=${value}`)
    .join(",");
}

// The variants of a plan matching every axis=value in filter.
export function matchingVariants(plan, filter) {
  const wanted = Object.entries(filter);
  return everyVariant(plan).filter((variant) => wanted.every(([axis, value]) => variant[axis] === value));
}

export function planName(name, variant, modules) {
  return `${name}${Object.entries(variant)
    .map(([axis, value]) => `[${axis}=${value}]`)
    .join("")}${modules ? `:${modules}` : ""}`;
}

export function findPlan(catalogue, name) {
  const plan = catalogue.find(({ planName }) => planName === name);
  if (!plan) throw new Error(`the suite has no plan named ${name}`);
  return plan;
}

export class Cancelled extends Error {}

function answer(value) {
  if (isCancel(value)) {
    cancel("Cancelled.");
    throw new Cancelled();
  }
  return value;
}

export async function choosePlan(plans, tag) {
  intro(`OpenID conformance suite (${tag})`);
  const name = answer(
    await select({
      message: "Which plan?",
      options: plans
        .toSorted((a, b) => a.planName.localeCompare(b.planName))
        .map(({ planName, displayName }) => ({ value: planName, label: planName, hint: displayName })),
      initialValue: defaultPlan,
    }),
  );
  return findPlan(plans, name);
}

// One multiselect per variant, as the suite's "Create a new test plan" page lists them.
export async function chooseVariants({ variants }) {
  const chosen = {};
  for (const [axis, variant] of Object.entries(variants)) {
    const values = variantValuesOf(variant);
    chosen[axis] = answer(
      await multiselect({
        message: variant.variantInfo.displayName,
        options: values.map((value) => ({ value, label: value })),
        initialValues: values,
        required: true,
      }),
    );
  }
  return combinations(chosen);
}

export async function chooseModules({ modules }, plans) {
  const scope = answer(
    await select({
      message: `Which modules for ${plans === 1 ? "1 plan" : `${plans} plans`}?`,
      options: [
        {
          value: "all",
          label: "All that apply",
          hint: `${modules.length} in the plan; each plan runs those its variant allows`,
        },
        { value: "some", label: "Choose…" },
      ],
    }),
  );
  if (scope === "all") return [];
  return answer(
    await autocompleteMultiselect({
      message: "Modules",
      options: modules.map(({ testModule }) => ({ value: testModule, label: testModule })),
      placeholder: "Type to filter",
      maxItems: 12,
      required: true,
    }),
  );
}
