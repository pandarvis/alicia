<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { GoogleAccountSummary, GoogleOwner } from "@alicia/protocol";
  import { onMount } from "svelte";
  import { flip } from "svelte/animate";
  import { fade, slide } from "svelte/transition";
  import type { AccountsScreen } from "../lib/accounts-screen.svelte.ts";
  import { motion } from "../lib/motion.ts";

  let { screen }: { screen: AccountsScreen } = $props();

  const uid = $props.id();

  interface Section {
    owner: GoogleOwner;
    title: string;
    hint: string;
    add: string;
    items: GoogleAccountSummary[];
  }

  const SINCE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  const sections: Section[] = $derived([
    {
      owner: "common", title: "Famille", hint: "Partagés : toute la famille y a accès.",
      add: "Ajouter un compte Famille", items: screen.common,
    },
    {
      owner: "personal", title: "Moi", hint: "Rien qu'à toi : personne d'autre n'y a accès.",
      add: "Ajouter mon compte", items: screen.personal,
    },
  ]);

  // Every visit shows the accounts as they are now (a turn may have flagged one meanwhile).
  onMount(() => {
    void screen.load();
  });
</script>

<section class="accounts" data-testid="accounts-view">
  <header>
    <h1>Comptes Google</h1>
    <p class="lead">Alicia lit les agendas et les mails de ces comptes, et y prépare des brouillons. Elle n'envoie jamais de mail.</p>
  </header>

  {#if screen.connecting}
    <div class="banner waiting" role="status" data-testid="accounts-waiting" transition:slide={{ duration: motion(180) }}>
      <span>Termine la connexion dans ton navigateur…</span>
      <button class="link" onclick={() => { screen.cancel(); }} data-testid="accounts-cancel">Annuler</button>
    </div>
  {/if}
  {#if screen.message}
    <p class="banner message" class:error={screen.message.tone === "error"} role="status" data-testid="accounts-message" transition:slide={{ duration: motion(150) }}>
      {screen.message.text}
    </p>
  {/if}

  <div class="body">
    {#if screen.phase === "loading"}
      <p class="muted" transition:fade={{ duration: motion(150) }}>Chargement…</p>
    {:else if screen.phase === "unavailable"}
      <p class="muted" data-testid="accounts-unavailable" transition:fade={{ duration: motion(150) }}>
        Google n'est pas configuré sur le cerveau d'Alicia.
      </p>
    {:else if screen.phase === "failed"}
      <p class="muted" transition:fade={{ duration: motion(150) }}>
        Impossible de charger les comptes. <button class="link" onclick={() => void screen.load()}>Réessayer</button>
      </p>
    {:else}
      <div class="sections" transition:fade={{ duration: motion(180) }}>
        {#each sections as section (section.owner)}
          <section class="section" aria-labelledby="{uid}-{section.owner}" data-testid="accounts-section-{section.owner}">
            <h2 id="{uid}-{section.owner}">{section.title}</h2>
            <p class="hint">{section.hint}</p>
            <ul>
              {#each section.items as account (account.id)}
                <li class="row" data-testid="account-row" animate:flip={{ duration: motion(180) }} in:fade={{ duration: motion(180) }} out:slide={{ duration: motion(180) }}>
                  <div class="who">
                    <span class="email" title={account.email}>{account.email}</span>
                    <span class="since">connecté le {SINCE.format(new Date(account.connectedAt))}</span>
                  </div>
                  <span class="status" class:attention={account.status === "reconnect"} data-testid="account-status">
                    {account.status === "connected" ? "Connecté" : "À reconnecter"}
                  </span>
                  <div class="end">
                    {#if screen.removingId === account.id}
                      <span class="ask" role="group" aria-label="Retirer {account.email} ?" in:fade={{ duration: motion(150) }}>
                        <span class="question">Retirer ?</span>
                        <button class="yes" onclick={() => void screen.confirmRemove()} disabled={screen.removing} data-testid="account-remove-yes">Oui</button>
                        <button class="no" onclick={() => { screen.keep(); }} disabled={screen.removing} data-testid="account-remove-no">Non</button>
                      </span>
                    {:else}
                      <span class="actions" in:fade={{ duration: motion(150) }}>
                        {#if account.status === "reconnect"}
                          <button class="reconnect" onclick={() => void screen.reconnect(account.id)} disabled={screen.connecting !== null} data-testid="account-reconnect">
                            <RefreshCw size={14} aria-hidden="true" />Reconnecter
                          </button>
                        {/if}
                        <button class="remove" onclick={() => { screen.askRemove(account.id); }} disabled={screen.connecting !== null} title="Retirer" aria-label="Retirer {account.email}" data-testid="account-remove">
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </span>
                    {/if}
                  </div>
                </li>
              {:else}
                <li class="empty" in:fade={{ duration: motion(150) }}>Aucun compte pour l'instant.</li>
              {/each}
            </ul>
            <button class="add" onclick={() => void screen.add(section.owner)} disabled={screen.connecting !== null} data-testid="accounts-add-{section.owner}">
              <Plus size={16} aria-hidden="true" />{section.add}
            </button>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .accounts { flex: 1; min-height: 0; overflow-y: auto; padding: 28px 32px; display: flex; flex-direction: column; gap: 16px; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  .lead, .hint, .muted { margin: 0; color: var(--cream-muted); }
  /* The loading, empty and list states share one cell, so they cross-fade in place. */
  .body { display: grid; grid-template-columns: minmax(0, 1fr); }
  .body > :global(*) { grid-area: 1 / 1; }
  .banner {
    margin: 0; padding: 10px 14px; border-radius: var(--radius); background: var(--night-deep);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .message { color: var(--sage); }
  .message.error { color: var(--amber); }
  .sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; align-items: start; }
  .section { background: var(--night-deep); border: 1px solid var(--surface); border-radius: var(--radius); padding: 16px; }
  h2 { margin: 0; font-size: 16px; }
  .hint { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  ul { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 10px;
    padding: 8px 10px; border-radius: 8px; background: var(--surface);
  }
  .who { display: flex; flex-direction: column; min-width: 0; }
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
  .since { font-size: 12px; color: var(--muted); }
  .status {
    font-size: 12px; padding: 2px 8px; border-radius: 999px; color: var(--night);
    background: var(--sage); transition: background var(--duration) ease;
  }
  .status.attention { background: var(--amber); }
  /* The actions and the Oui / Non question take turns in the same cell. */
  .end { display: grid; justify-items: end; }
  .end > * { grid-area: 1 / 1; }
  .empty { color: var(--muted); font-size: 13px; padding: 4px 2px; }
  button {
    background: none; border: 0; cursor: pointer; border-radius: 8px; color: inherit; font: inherit;
    transition: background var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease;
  }
  button:disabled { cursor: default; opacity: 0.6; }
  .actions, .ask { display: flex; align-items: center; gap: 4px; }
  .reconnect { display: flex; align-items: center; gap: 6px; padding: 4px 10px; color: var(--amber); font-weight: 700; }
  .remove { display: grid; place-items: center; width: 28px; height: 28px; color: var(--muted); }
  .remove:hover:not(:disabled), .reconnect:hover:not(:disabled) { background: var(--surface-raised); }
  .remove:hover:not(:disabled) { color: var(--amber); }
  .question { font-weight: 700; margin-right: 4px; }
  .yes { padding: 3px 10px; background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .yes:hover:not(:disabled) { background: var(--night-deep); }
  .no { padding: 3px 10px; color: var(--cream-muted); }
  .no:hover:not(:disabled) { background: var(--surface-raised); }
  .add { display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--sage); font-weight: 700; }
  .add:hover:not(:disabled) { background: var(--surface); }
  .link { color: var(--sage); padding: 2px 4px; }
  .link:hover { color: var(--cream); }
</style>
