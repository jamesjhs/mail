import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api";
import type { AuditItem, PendingItem, Rule } from "./types";

declare global {
  interface Window {
    turnstile?: {
      render: (
        selector: string,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      remove?: (widgetId: string) => void;
    };
  }
}

const tabs = ["Overview", "Rules", "Pending", "Server log", "Settings", "Help"] as const;
const turnstileLoadRetryMs = 250;
const maxTurnstileLoadAttempts = 40;

export function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileError, setTurnstileError] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [otp, setOtp] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [version, setVersion] = useState("v0.0.1");
  const [rules, setRules] = useState<Rule[]>([]);
  const [audit, setAudit] = useState<{
    total: number;
    items: AuditItem[];
  }>({ total: 0, items: [] });
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [logMessageId, setLogMessageId] = useState("");
  const [helpHtml, setHelpHtml] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [savedAdminEmail, setSavedAdminEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [secretDirty, setSecretDirty] = useState(false);
  const [secretVisible, setSecretVisible] = useState(false);
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendConfigured, setResendConfigured] = useState(false);
  const [resendMessage, setResendMessage] = useState("");
  const [error, setError] = useState("");
  const turnstileWidgetIdRef = useRef<string | null>(null);

  const isResetRoute = useMemo(() => window.location.pathname === "/reset-password", []);

  useEffect(() => {
    api.getPublicConfig().then((config) => {
      setVersion(config.version);
      setTurnstileSiteKey(config.turnstileSiteKey);
    });

    api
      .getMe()
      .then(async (me) => {
        setAdminEmail(me.email);
        setSavedAdminEmail(me.email);
        await api.getCsrfToken();
        setAuthenticated(true);
      })
      .catch(() => {
        setAuthenticated(false);
      });
  }, []);

  useEffect(() => {
    if (authenticated || challengeId || !turnstileSiteKey) {
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const renderTurnstile = () => {
      if (cancelled) {
        return;
      }

      if (!window.turnstile) {
        attempts += 1;
        if (attempts > maxTurnstileLoadAttempts) {
          setTurnstileError("Turnstile failed to load. Refresh and try again.");
          return;
        }

        setTimeout(renderTurnstile, turnstileLoadRetryMs);
        return;
      }

      if (turnstileWidgetIdRef.current) {
        window.turnstile.remove?.(turnstileWidgetIdRef.current);
        turnstileWidgetIdRef.current = null;
      }

      turnstileWidgetIdRef.current = window.turnstile.render("#turnstile", {
        sitekey: turnstileSiteKey,
        callback: (token) => {
          setTurnstileToken(token);
          setTurnstileError("");
        },
        "expired-callback": () => {
          setTurnstileToken("");
        },
        "error-callback": () => {
          setTurnstileToken("");
          setTurnstileError("Turnstile challenge failed. Verify your site key domain and retry.");
        },
      });
    };

    renderTurnstile();

    return () => {
      cancelled = true;
      if (turnstileWidgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(turnstileWidgetIdRef.current);
        turnstileWidgetIdRef.current = null;
      }
    };
  }, [authenticated, challengeId, turnstileSiteKey]);

  const refreshAdminData = useCallback(
    async (targetPage = page) => {
      const [fetchedRules, fetchedAudit, fetchedPending, settings, me] = await Promise.all([
        api.listRules(),
        api.listAudit(targetPage),
        api.listPending(),
        api.getSettings(),
        api.getMe(),
      ]);

      setRules(fetchedRules);
      setAudit({ total: fetchedAudit.total, items: fetchedAudit.items });
      setPending(fetchedPending);
      setAdminEmail(me.email);
      setSavedAdminEmail(me.email);
      setWebhookSecret(settings.find((setting) => setting.key === "webhook_signing_secret")?.value ?? "");
      setSecretDirty(false);
      setResendConfigured(Boolean(settings.find((setting) => setting.key === "resend_api_key")?.value));
    },
    [page],
  );

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const timer = setTimeout(() => {
      refreshAdminData().catch((err) => setError(String(err)));
    }, 0);

    return () => clearTimeout(timer);
  }, [authenticated, page, refreshAdminData]);

  useEffect(() => {
    if (authenticated && tab === "Help") {
      api.getHelp().then(setHelpHtml).catch((err) => setError(String(err)));
    }
  }, [authenticated, tab]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (!turnstileToken) {
      setError(turnstileError || "Complete the Turnstile challenge first.");
      return;
    }

    try {
      const response = await api.requestAuth({ email, password, turnstileToken });
      setChallengeId(response.challengeId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submitOtp = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    try {
      await api.verifyOtp({ challengeId, otp });
      await api.getCsrfToken();
      setAuthenticated(true);
      setChallengeId("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (isResetRoute) {
    return <ResetPasswordPage version={version} />;
  }

  if (!authenticated) {
    return (
      <main className="shell">
        <section className="card auth-card">
          <h1>Jahosi Mail Admin</h1>
          <p className="subtle">Secure login with Turnstile + OTP / magic link.</p>
          {!challengeId ? (
            <form onSubmit={login} className="form-stack">
              <input placeholder="Admin email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              <input
                placeholder="Admin password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <div id="turnstile" className="turnstile" />
              {turnstileError && <p className="error">{turnstileError}</p>}
              <button type="submit" disabled={!turnstileToken}>
                Send OTP + Magic Link
              </button>
            </form>
          ) : (
            <form onSubmit={submitOtp} className="form-stack">
              <input
                placeholder="6-digit OTP"
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
                minLength={6}
                maxLength={6}
                required
              />
              <button type="submit">Verify OTP</button>
            </form>
          )}
          {error && <p className="error">{error}</p>}
          <footer>{version}</footer>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="card full">
        <header className="header-row">
          <div>
            <h1>Jahosi Mail Dashboard</h1>
            <p className="subtle">Inbound webhook gateway control panel.</p>
          </div>
          <button
            onClick={async () => {
              await api.logout();
              location.reload();
            }}
          >
            Logout
          </button>
        </header>

        <nav className="tabs">
          {tabs.map((entry) => (
            <button key={entry} className={entry === tab ? "active" : ""} onClick={() => setTab(entry)}>
              {entry}
            </button>
          ))}
        </nav>

        {tab === "Overview" && (
          <>
            <h2>Message audit trail</h2>
            <p className="subtle">Total traversals: {audit.total}</p>
            <table>
              <thead>
                <tr>
                  <th>UUID</th>
                  <th>Status</th>
                  <th>Destination</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {audit.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.messageId}</td>
                    <td>{item.status}<br /><button onClick={() => { setLogMessageId(item.messageId); setTab("Server log"); }}>View log</button></td>
                    <td>{item.destination || "n/a"}</td>
                    <td>{item.eventTime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
              <span>Page {page}</span>
              <button onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </>
        )}

        {tab === "Rules" && (
          <RulesPanel
            rules={rules}
            onChanged={async () => {
              await refreshAdminData();
            }}
          />
        )}

        {tab === "Pending" && (
          <>
            <h2>Pending/failed queue</h2>
            <button onClick={() => refreshAdminData().catch((err) => setError(String(err)))}>Refresh queue</button>
            <table>
              <thead>
                <tr>
                  <th>UUID</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Destination</th>
                  <th>Last error</th>
                  <th>Last attempt (UTC)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((item) => (
                  <tr key={item.id}>
                    <td>{item.id}</td>
                    <td>{item.status}</td>
                    <td>{item.attempts}</td>
                    <td>{item.destination ?? "n/a"}</td>
                    <td className="log-error">{item.last_error || "No error detail recorded"}</td>
                    <td>{item.last_attempt}</td>
                    <td className="action-cell">
                      <button onClick={() => { setLogMessageId(item.id); setTab("Server log"); }}>View log</button>
                      <button
                        onClick={async () => {
                          try {
                            await api.retryPending(item.id);
                            setError("");
                          } catch {
                            setError("Retry failed. Check the updated Last error or open View log for details.");
                          } finally {
                            await refreshAdminData().catch((err) => setError(String(err)));
                          }
                        }}
                      >
                        Retry
                      </button>
                      <button
                        onClick={async () => {
                          await api.bouncePending(item.id);
                          await refreshAdminData();
                        }}
                      >
                        Bounce
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {tab === "Server log" && <ServerLogPanel messageId={logMessageId} onClear={() => setLogMessageId("")} />}

        {tab === "Settings" && (
          <>
            <h2>Security settings</h2>
            <h3>Resend receiving and forwarding</h3>
            <p className="subtle">The existing Resend webhook receives incoming mail. Add an API key with permission to read received emails and attachments to forward complete messages using the configured SMTP service.</p>
            <p>Resend API key: {resendConfigured ? "Configured" : "Not configured"}</p>
            <label className="stack">
              Resend API key
              <input type="password" value={resendApiKey} onChange={(event) => setResendApiKey(event.target.value)} placeholder="re_..." autoComplete="off" />
            </label>
            <button disabled={!resendApiKey.trim()} onClick={async () => {
              try {
                await api.setResendApiKey(resendApiKey.trim());
                setResendApiKey("");
                setResendConfigured(true);
                setResendMessage("Resend API key saved. Create an email forwarding rule in Rules.");
              } catch (err) { setResendMessage((err as Error).message); }
            }}>Save Resend API key</button>
            <button disabled={!resendConfigured} onClick={async () => {
              try {
                await api.setResendApiKey("");
                setResendConfigured(false);
                setResendMessage("API key removed. Email forwarding will queue until a key is saved.");
              } catch (err) { setResendMessage((err as Error).message); }
            }}>Remove Resend API key</button>
            {resendMessage && <p role="status">{resendMessage}</p>}
            <h3>Admin account</h3>
            <label className="stack">
              Admin email
              <input value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} autoComplete="email" />
            </label>
            <label className="stack">
              Current password
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label className="stack">
              New password (optional)
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={10}
              />
            </label>
            <button
              disabled={!currentPassword || (!newPassword && adminEmail === savedAdminEmail)}
              onClick={async () => {
                const payload: { email?: string; currentPassword: string; newPassword?: string } = {
                  currentPassword,
                };
                if (adminEmail !== savedAdminEmail) {
                  payload.email = adminEmail;
                }
                if (newPassword) {
                  payload.newPassword = newPassword;
                }
                await api.updateAdminAccount(payload);
                setCurrentPassword("");
                setNewPassword("");
                await refreshAdminData();
              }}
            >
              Save account
            </button>
            <label className="stack">
              Webhook signing secret
              <div className="secret-row">
                <input
                  type={secretVisible ? "text" : "password"}
                  value={webhookSecret}
                  onChange={(event) => {
                    setWebhookSecret(event.target.value);
                    setSecretDirty(true);
                  }}
                  autoComplete="off"
                />
                <button type="button" onClick={() => setSecretVisible((v) => !v)}>
                  {secretVisible ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <button
              disabled={!secretDirty}
              onClick={async () => {
                await api.setWebhookSecret(webhookSecret);
                setSecretDirty(false);
              }}
            >
              Save secret
            </button>
          </>
        )}

        {tab === "Help" && <article className="help-body" dangerouslySetInnerHTML={{ __html: helpHtml }} />}

        {error && <p className="error">{error}</p>}
        <footer>{version}</footer>
      </section>
    </main>
  );
}

function ServerLogPanel({ messageId, onClear }: { messageId: string; onClear: () => void }) {
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<{ total: number; items: AuditItem[] }>({ total: 0, items: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.listAudit(page, 20, messageId);
        if (!cancelled) setLogs(result);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [page, messageId, refresh]);

  return <>
    <h2>Server delivery log</h2>
    <p className="subtle">Delivery results and failure reasons recorded by the server. Login email delivery does not check Resend access to received messages or attachments. Times are UTC.</p>
    <p className="subtle">Older entries show the last stored failure when available; earlier attempt details were not recorded.</p>
    {messageId && <p>Message: <code>{messageId}</code> <button onClick={() => { setPage(1); onClear(); }}>Show all messages</button></p>}
    <button disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? "Loading…" : "Refresh log"}</button>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="log-table-wrap" aria-busy={loading}>
      <table>
        <thead><tr><th>Time (UTC)</th><th>Message</th><th>Status</th><th>Attempt</th><th>Destination</th><th>Details</th></tr></thead>
        <tbody>{logs.items.map((item) => <tr key={item.id}>
          <td>{item.eventTime}</td><td>{item.messageId}</td><td>{item.status}</td><td>{item.attempt ?? "—"}</td>
          <td>{item.destination?.replace(/^mailto:/, "") || "—"}</td>
          <td className="log-error">{item.error || (item.status.startsWith("SUCCESS") ? "Delivered" : "No error detail recorded")}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!loading && !error && logs.items.length === 0 && <p>No delivery log entries found.</p>}
    <div className="pager">
      <button disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>Prev</button>
      <span>Page {page} · {logs.total} entries</span>
      <button disabled={page * 20 >= logs.total || loading} onClick={() => setPage((value) => value + 1)}>Next</button>
    </div>
  </>;
}

function RulesPanel({
  rules,
  onChanged,
}: {
  rules: Rule[];
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    name: "",
    pattern: "",
    patternType: "wildcard" as "wildcard" | "regex",
    endpointUrl: "",
    webhookKey: "",
  });
  const [draftWebhookVisible, setDraftWebhookVisible] = useState(false);
  const [visibleWebhookKeys, setVisibleWebhookKeys] = useState<Record<number, boolean>>({});
  const [destinationType, setDestinationType] = useState<"email" | "webhook">("email");
  const [ruleError, setRuleError] = useState("");

  return (
    <>
      <h2>Routing rules</h2>
      <p className="subtle">Match the part before @: use apps for apps@jahosi.co.uk, or * for all recipients. Email forwarding requires a Resend API key in Settings. Rules are checked in creation order; the first enabled match is used.</p>
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setRuleError("");
          try {
            const webhookKey = draft.webhookKey.trim() || (await api.generateRuleWebhookKey()).webhookKey;
            await api.createRule({
              ...draft,
              endpointUrl: destinationType === "email" ? `mailto:${draft.endpointUrl.trim()}` : draft.endpointUrl.trim(),
              webhookKey,
            });
            setDraft({ name: "", pattern: "", patternType: "wildcard", endpointUrl: "", webhookKey: "" });
            setDraftWebhookVisible(false);
            await onChanged();
          } catch (err) {
            setRuleError((err as Error).message);
          }
        }}
      >
        <input placeholder="Rule name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
        <input placeholder="Pattern" value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} required />
        <select
          value={draft.patternType}
          onChange={(e) => setDraft({ ...draft, patternType: e.target.value as "wildcard" | "regex" })}
        >
          <option value="wildcard">Wildcard</option>
          <option value="regex">Regex</option>
        </select>
        <select aria-label="Forwarding destination type" value={destinationType} onChange={(event) => {
          setDestinationType(event.target.value as "email" | "webhook");
          setDraft({ ...draft, endpointUrl: "" });
        }}>
          <option value="email">Email address</option>
          <option value="webhook">Application webhook</option>
        </select>
        <input
          aria-label="Forwarding destination"
          type={destinationType === "email" ? "email" : "url"}
          placeholder={destinationType === "email" ? "you@example.com" : "https://example.com/hook/{ID}"}
          value={draft.endpointUrl}
          onChange={(e) => setDraft({ ...draft, endpointUrl: e.target.value })}
          required
        />
        {destinationType === "webhook" && <div className="secret-row">
          <input
            placeholder="Rule webhook key"
            type={draftWebhookVisible ? "text" : "password"}
            value={draft.webhookKey}
            onChange={(e) => setDraft({ ...draft, webhookKey: e.target.value })}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={async () => {
              const response = await api.generateRuleWebhookKey();
              setDraft({ ...draft, webhookKey: response.webhookKey });
            }}
          >
            Generate
          </button>
          <button type="button" onClick={() => setDraftWebhookVisible((visible) => !visible)}>
            {draftWebhookVisible ? "Hide" : "Show"}
          </button>
        </div>}
        <button type="submit">Add rule</button>
      </form>
      {ruleError && <p className="error" role="alert">{ruleError}</p>}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Pattern</th>
            <th>Type</th>
            <th>Destination</th>
            <th>Webhook key</th>
            <th>Enabled</th>
            <th>Delete</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td>{rule.name}</td>
              <td>{rule.pattern}</td>
              <td>{rule.patternType}</td>
              <td>{rule.endpointUrl.replace(/^mailto:/, "")}</td>
              <td>
                {rule.endpointUrl.startsWith("mailto:") ? "Email forwarding" : <div className="secret-row">
                  <input type={visibleWebhookKeys[rule.id] ? "text" : "password"} value={rule.webhookKey} readOnly />
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleWebhookKeys((current) => ({ ...current, [rule.id]: !current[rule.id] }))
                    }
                  >
                    {visibleWebhookKeys[rule.id] ? "Hide" : "Show"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(rule.webhookKey);
                    }}
                  >
                    Copy
                  </button>
                </div>}
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={rule.enabled === 1}
                  onChange={async (event) => {
                    await api.updateRule({ ...rule, enabled: event.target.checked ? 1 : 0 });
                    await onChanged();
                  }}
                />
              </td>
              <td>
                <button
                  onClick={async () => {
                    await api.deleteRule(rule.id);
                    await onChanged();
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ResetPasswordPage({ version }: { version: string }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  return (
    <main className="shell">
      <section className="card auth-card">
        <h1>Reset admin password</h1>
        <form
          className="form-stack"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api.resetPassword({ token, password });
              setMessage("Password updated. Return to / and login.");
            } catch (error) {
              setMessage((error as Error).message);
            }
          }}
        >
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="New strong password"
            required
            minLength={10}
          />
          <button type="submit">Set password</button>
        </form>
        <p className="subtle">{message}</p>
        <footer>{version}</footer>
      </section>
    </main>
  );
}
