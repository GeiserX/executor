import {
  getPropertyName,
  isDeclarationFile,
  isIdentifier,
  isTestLike,
  unwrapExpression,
} from "../utils.js";

const message =
  'Unwrapping a credential is a boundary decision, not a convenience. Keep the value `Redacted` and let the wire/persistence line unwrap it; if this IS that line, mark it: `// oxlint-disable-next-line executor/no-redacted-unwrap -- boundary: <why the plaintext has to cross here>`. A missed unwrap on a write path does not throw — `Redacted`\'s toJSON renders the literal "<redacted>" and it is persisted instead.';

// Matches the reference too, not just the call: `.map(Redacted.value)` and
// `SchemaGetter.transform(Redacted.value<string>)` unwrap exactly as much as an
// applied call does.
const isRedactedUnwrap = (node) =>
  isIdentifier(unwrapExpression(node.object), "Redacted") &&
  getPropertyName(node.property) === "value";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Redacted.value outside allowlisted credential boundaries.",
    },
  },
  create(context) {
    // Tests unwrap to assert the bytes that actually reach a backend — the
    // assertion that catches a missed unwrap in the first place.
    if (isTestLike(context.filename) || isDeclarationFile(context.filename)) return {};

    return {
      MemberExpression(node) {
        if (isRedactedUnwrap(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
