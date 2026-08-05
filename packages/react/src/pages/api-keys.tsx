import { useState, type ReactNode } from "react";
import { Exit } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { toast } from "sonner";
import { apiKeyWriteKeys, orgApiKeyWriteKeys } from "../api/reactivity-keys";
import { trackEvent } from "../api/analytics";
import {
  apiKeysAtom,
  createApiKey,
  createOrgApiKey,
  orgApiKeysAtom,
  revokeApiKey,
  revokeOrgApiKey,
} from "../api/account-atoms";
import { useIsTenantAdmin } from "../multiplayer/use-admin-nav";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
import { CopyButton } from "../components/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { ErrorState } from "../components/error-state";
import { isAsyncResultLoading } from "../lib/async-result";

// ---------------------------------------------------------------------------
// Shared API-keys page. Reads/writes the provider-neutral `/account/api-keys`
// surface, so it works identically on cloud (WorkOS) and self-host (Better
// Auth). API keys are how a user authenticates the Executor API + MCP endpoint
// from scripts/agents (Authorization: Bearer <key>).
//
// `orgKeysSection` is a host slot (the OrgPage pattern): cloud passes
// `<OrgApiKeysSection />` below; self-host passes nothing because its provider
// refuses org keys (`/admin/*` there is gated on an owner/admin session).
// ---------------------------------------------------------------------------

type ApiKeySummary = {
  readonly id: string;
  readonly name: string;
  readonly obfuscatedValue: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
};

type CreatedKey = ApiKeySummary & { readonly value: string };

const formatDate = (value: string | null): string => {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
};

const defaultApiKeyName = (): string =>
  `API key ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date())}`;

/** The shared list markup — both key sections render the same columns. */
function KeyTable(props: {
  readonly keys: readonly ApiKeySummary[];
  readonly revokingId: string | null;
  readonly onRevoke: (key: ApiKeySummary) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground md:grid-cols-[1.4fr_1fr_1fr_auto]">
        <span>Name</span>
        <span className="hidden md:block">Created</span>
        <span className="hidden md:block">Last used</span>
        <span className="text-right">Actions</span>
      </div>
      {props.keys.map((key) => (
        <div
          key={key.id}
          className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-4 py-4 last:border-b-0 md:grid-cols-[1.4fr_1fr_1fr_auto]"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{key.name}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{key.obfuscatedValue}</p>
          </div>
          <p className="hidden text-sm text-muted-foreground md:block">
            {formatDate(key.createdAt)}
          </p>
          <p className="hidden text-sm text-muted-foreground md:block">
            {formatDate(key.lastUsedAt)}
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => props.onRevoke(key)}
            disabled={props.revokingId === key.id}
            title={`Revoke ${key.name}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <span aria-hidden="true">×</span>
          </Button>
        </div>
      ))}
    </div>
  );
}

/** The one-time reveal of a freshly minted key's value + Bearer header. */
function CreatedKeyReveal(props: {
  readonly value: string;
  readonly onCopy: (kind: "value" | "bearer_header") => void;
}) {
  return (
    <div className="grid gap-4 py-3">
      <div className="grid gap-1.5">
        <Label className="text-sm font-medium text-foreground">New key</Label>
        <div className="flex items-center gap-2">
          <Input value={props.value} readOnly className="font-mono text-xs" data-ph-mask />
          <CopyButton value={props.value} onCopy={() => props.onCopy("value")} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-sm font-medium text-foreground">Bearer header</Label>
        <div className="flex items-center gap-2">
          <Input
            value={`Authorization: Bearer ${props.value}`}
            readOnly
            className="font-mono text-xs"
            data-ph-mask
          />
          <CopyButton
            value={`Authorization: Bearer ${props.value}`}
            onCopy={() => props.onCopy("bearer_header")}
          />
        </div>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        Send this value as a Bearer token. It is only shown once.
      </p>
    </div>
  );
}

export function ApiKeysPage(props: { readonly orgKeysSection?: ReactNode } = {}) {
  useExecutorDocumentTitle("API keys");
  const result = useAtomValue(apiKeysAtom);
  const refreshApiKeys = useAtomRefresh(apiKeysAtom);
  const doCreate = useAtomSet(createApiKey, { mode: "promiseExit" });
  const doRevoke = useAtomSet(revokeApiKey, { mode: "promiseExit" });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const exit = await doCreate({ payload: { name: trimmed }, reactivityKeys: apiKeyWriteKeys });
    setCreating(false);
    trackEvent("api_key_created", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      setCreatedKey(exit.value);
      setName("");
      toast.success("API key created");
      return;
    }
    toast.error("Failed to create API key");
  };

  const handleRevoke = async (key: ApiKeySummary) => {
    setRevokingId(key.id);
    const exit = await doRevoke({ params: { apiKeyId: key.id }, reactivityKeys: apiKeyWriteKeys });
    setRevokingId(null);
    trackEvent("api_key_revoked", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success(`Revoked ${key.name}`);
      return;
    }
    toast.error("Failed to revoke API key");
  };

  const closeCreate = (open: boolean) => {
    setCreateOpen(open);
    if (!open) {
      setName("");
      setCreatedKey(null);
      setCreating(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="API keys"
        description="User keys for accessing the Executor API and MCP endpoint from scripts and tools."
        actions={
          <Button
            onClick={() => {
              setName(defaultApiKeyName());
              setCreateOpen(true);
            }}
          >
            <span aria-hidden="true">+</span>
            New key
          </Button>
        }
      >
        <div className="mt-4 flex max-w-2xl items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            Authorization: Bearer &lt;api-key&gt;
          </code>
          <CopyButton value="Authorization: Bearer <api-key>" />
        </div>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
          API keys work like personal access tokens: they act as you, in this organization, with
          full access to your own account.
        </p>
      </PageHeader>

      {isAsyncResultLoading(result) ? (
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading API keys...
        </div>
      ) : (
        AsyncResult.match(result, {
          onInitial: () => (
            <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading API keys...
            </div>
          ),
          onFailure: () => (
            <ErrorState message="Failed to load API keys" onRetry={refreshApiKeys} />
          ),
          onSuccess: ({ value }) =>
            value.apiKeys.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-card p-8">
                <h2 className="text-base font-semibold text-foreground">No API keys</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Create a key and send it in the Authorization Bearer header.
                </p>
              </div>
            ) : (
              <KeyTable keys={value.apiKeys} revokingId={revokingId} onRevoke={handleRevoke} />
            ),
        })
      )}

      {props.orgKeysSection}

      <Dialog open={createOpen} onOpenChange={closeCreate}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Create API key</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              The key will act as your user in the current organization.
            </DialogDescription>
          </DialogHeader>

          {createdKey ? (
            <CreatedKeyReveal
              value={createdKey.value}
              onCopy={(kind) => trackEvent("api_key_copied", { kind })}
            />
          ) : (
            <div className="grid gap-4 py-3">
              <div className="grid gap-1.5">
                <Label htmlFor="api-key-name" className="text-sm font-medium text-foreground">
                  Name
                </Label>
                <Input
                  id="api-key-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Local CLI"
                  maxLength={80}
                  autoFocus
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Close</Button>
            </DialogClose>
            {!createdKey && (
              <Button onClick={handleCreate} disabled={creating || !name.trim()}>
                {creating ? "Creating..." : "Create key"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Organization keys — the admin-only, org-owned credentials for the read-only
// admin API (`/api/admin/*`). A separate section rather than rows in the table
// above because the two key kinds answer different questions: a personal key
// acts AS the member who minted it on the product plane; an org key has no
// member behind it and reads the whole tenant.
//
// Rendered via the page's `orgKeysSection` slot by hosts that mint org keys
// (cloud). The admin gate here only HIDES the section — the server enforces
// the real one (403 for a plain member) and the section renders that refusal
// as an error state if it arrives anyway.
// ---------------------------------------------------------------------------

export function OrgApiKeysSection() {
  // Gate BEFORE mounting the body: `orgApiKeysAtom` starts its fetch when the
  // reading component mounts, and for a plain member that request is a
  // guaranteed 403. Fail-closed like the admin nav — while the member list is
  // loading, show nothing rather than a section that will refuse.
  const isAdmin = useIsTenantAdmin();
  return isAdmin ? <OrgApiKeysSectionBody /> : null;
}

function OrgApiKeysSectionBody() {
  const result = useAtomValue(orgApiKeysAtom);
  const refresh = useAtomRefresh(orgApiKeysAtom);
  const doRevoke = useAtomSet(revokeOrgApiKey, { mode: "promiseExit" });
  const [createOpen, setCreateOpen] = useState(false);
  // Remount the dialog body per open (self-contained modal): its form and
  // created-key state are destroyed on close instead of hand-reset, while the
  // Dialog shell stays mounted for the exit animation.
  const [openCount, setOpenCount] = useState(0);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const handleRevoke = async (key: ApiKeySummary) => {
    setRevokingId(key.id);
    const exit = await doRevoke({
      params: { apiKeyId: key.id },
      reactivityKeys: orgApiKeyWriteKeys,
    });
    setRevokingId(null);
    trackEvent("org_api_key_revoked", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      toast.success(`Revoked ${key.name}`);
      return;
    }
    toast.error("Failed to revoke organization key");
  };

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Organization keys</h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Read-only keys owned by the organization, not a member. They authenticate the admin API
            (who are my users, what have they connected) and cannot act as anyone or write anything.
            Admins only.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setOpenCount((count) => count + 1);
            setCreateOpen(true);
          }}
        >
          <span aria-hidden="true">+</span>
          New org key
        </Button>
      </div>

      {isAsyncResultLoading(result) ? (
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading organization keys...
        </div>
      ) : (
        AsyncResult.match(result, {
          onInitial: () => (
            <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading organization keys...
            </div>
          ),
          onFailure: () => (
            <ErrorState message="Failed to load organization keys" onRetry={refresh} />
          ),
          onSuccess: ({ value }) =>
            value.apiKeys.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-card p-8">
                <h3 className="text-base font-semibold text-foreground">No organization keys</h3>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Create one to call the admin API from your backend.
                </p>
              </div>
            ) : (
              <KeyTable keys={value.apiKeys} revokingId={revokingId} onRevoke={handleRevoke} />
            ),
        })
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[480px]">
          {createOpen ? <CreateOrgKeyDialogBody key={openCount} /> : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CreateOrgKeyDialogBody() {
  const doCreate = useAtomSet(createOrgApiKey, { mode: "promiseExit" });
  const [name, setName] = useState(defaultApiKeyName());
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const exit = await doCreate({
      payload: { name: trimmed },
      reactivityKeys: orgApiKeyWriteKeys,
    });
    setCreating(false);
    trackEvent("org_api_key_created", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      setCreatedKey(exit.value);
      toast.success("Organization key created");
      return;
    }
    toast.error("Failed to create organization key");
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl">Create organization key</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          The key will belong to the organization itself — not to you — with read-only access to the
          admin API across the whole organization.
        </DialogDescription>
      </DialogHeader>

      {createdKey ? (
        <CreatedKeyReveal
          value={createdKey.value}
          onCopy={(kind) => trackEvent("org_api_key_copied", { kind })}
        />
      ) : (
        <div className="grid gap-4 py-3">
          <div className="grid gap-1.5">
            <Label htmlFor="org-api-key-name" className="text-sm font-medium text-foreground">
              Name
            </Label>
            <Input
              id="org-api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Backend admin reader"
              maxLength={80}
              autoFocus
            />
          </div>
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Close</Button>
        </DialogClose>
        {!createdKey && (
          <Button onClick={handleCreate} disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "Create key"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
