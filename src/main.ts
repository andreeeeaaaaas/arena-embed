import { App, Modal, Plugin, PluginSettingTab, Setting, TFile, type Editor, type MarkdownPostProcessorContext } from 'obsidian';
import { ArenaClient } from './api';
import { embedMarkdown, parseChannel, parseCount, parseEmbed } from './channel';
import { VIEWS, type View } from './layouts';
import { ChannelEmbed, type Snapshot } from './embed';
import { Lightbox } from './lightbox';

interface ArenaSettings { token: string; wide: boolean; click: 'preview' | 'arena' }

export default class ArenaPlugin extends Plugin {
  settings: ArenaSettings = { token: '', wide: false, click: 'preview' };
  client = new ArenaClient();
  private embeds = new Set<ChannelEmbed>();
  // Images an embed was showing when it saved a new count, picked up by its re-render.
  private handoffs = new Map<string, Snapshot & { expires: number }>();

  async onload(): Promise<void> {
    const stored = await this.loadData() as Partial<ArenaSettings> | null;
    this.settings.token = typeof stored?.token === 'string' ? stored.token : '';
    this.settings.wide = stored?.wide === true;
    this.settings.click = stored?.click === 'arena' ? 'arena' : 'preview';
    this.client.setToken(this.settings.token);
    this.addSettingTab(new ArenaSettingsTab(this.app, this));
    this.addCommand({
      id: 'embed-channel', name: 'Embed channel',
      editorCallback: (editor: Editor) => { new InsertChannelModal(this.app, editor, this.settings.wide).open(); },
    });
    this.registerMarkdownCodeBlockProcessor('arena', (source, el, context) => {
      try {
        const options = parseEmbed(source);
        const key = handoffKey(context.sourcePath, options.channel, options.count);
        const handoff = this.handoffs.get(key);
        this.handoffs.delete(key);
        const initial = handoff && handoff.expires > Date.now() ? handoff : undefined;
        const child = new ChannelEmbed(el, this.client, options, {
          saveCount: (count, snapshot) => this.saveCount(el, context, options.channel, count, snapshot),
          preview: (items, index) => {
            if (this.settings.click !== 'preview') return false;
            new Lightbox(this.app, items, index).open();
            return true;
          },
        }, initial);
        child.setDefaultWide(this.settings.wide);
        this.embeds.add(child);
        child.register(() => this.embeds.delete(child));
        context.addChild(child);
      } catch (error) {
        el.createDiv({ cls: 'arena-status', text: error instanceof Error ? error.message : 'Enter an Are.na channel URL.' });
      }
    });
  }

  // Rewrites only this block's count line. Returns false when the block can't be
  // located safely, e.g. in a hover preview or after the note changed underneath.
  private async saveCount(el: HTMLElement, context: MarkdownPostProcessorContext, channel: string, count: number, snapshot: Snapshot): Promise<boolean> {
    const info = context.getSectionInfo(el);
    const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
    if (!info || !(file instanceof TFile)) return false;
    const rendered = info.text.split(/\r?\n/).slice(info.lineStart, info.lineEnd + 1);
    let saved = false;
    const key = handoffKey(context.sourcePath, channel, count);
    this.handoffs.set(key, { ...snapshot, expires: Date.now() + 10_000 });
    await this.app.vault.process(file, data => {
      const eol = data.includes('\r\n') ? '\r\n' : '\n';
      const lines = data.split(/\r?\n/);
      const block = lines.slice(info.lineStart, info.lineEnd + 1);
      if (block.join('\n') !== rendered.join('\n') || !/^\s*(```|~~~)\s*arena\b/.test(block[0] ?? '')) return data;
      const body = block.slice(1, -1);
      const index = body.findIndex(line => /^\s*(count|per):/.test(line));
      if (index >= 0) body[index] = `count: ${count}`;
      else body.push(`count: ${count}`);
      lines.splice(info.lineStart + 1, block.length - 2, ...body);
      saved = true;
      return lines.join(eol);
    });
    if (!saved) this.handoffs.delete(key);
    return saved;
  }

  async saveWide(wide: boolean): Promise<void> {
    this.settings.wide = wide;
    for (const embed of this.embeds) embed.setDefaultWide(wide);
    await this.saveData(this.settings);
  }

  async saveToken(token: string): Promise<void> {
    this.settings.token = token.trim();
    this.client.setToken(this.settings.token);
    this.handoffs.clear();
    // Remove visible private content when the authentication context changes.
    for (const embed of this.embeds) {
      embed.unload();
      embed.containerEl.empty();
      embed.containerEl.createDiv({ cls: 'arena-status', text: 'Token updated. Reopen this note to reload its embeds.' });
    }
    await this.saveData(this.settings);
  }

  onunload(): void {
    for (const embed of this.embeds) {
      embed.unload();
      embed.containerEl.empty();
    }
    this.client.clear();
    this.handoffs.clear();
  }
}

function handoffKey(sourcePath: string, channel: string, count?: number): string {
  return `${sourcePath}\n${channel}\n${count ?? ''}`;
}

class InsertChannelModal extends Modal {
  constructor(app: App, private editor: Editor, private wideByDefault: boolean) { super(app); }

  onOpen(): void {
    this.titleEl.setText('Embed an Are.na channel');
    const form = this.contentEl.createEl('form', { cls: 'arena-insert-form' });
    // A selected channel URL is the likely target; inserting replaces it with the block.
    const selection = this.editor.getSelection().trim();
    let selected = '';
    try { parseChannel(selection); selected = selection; } catch { /* not a channel */ }

    let input!: HTMLInputElement;
    new Setting(form).setName('Channel').setDesc('Paste a channel URL or slug.').setClass('arena-channel-setting')
      .addText(text => {
        input = text.inputEl;
        text.setPlaceholder('https://www.are.na/username/channel').setValue(selected);
        input.autocomplete = 'off';
        input.spellcheck = false;
      });

    const viewNames: Record<View, string> = { masonry: 'Masonry', filmstrip: 'Filmstrip', 'contact-sheet': 'Contact sheet', pinboard: 'Pinboard' };
    const viewDescs: Record<View, string> = {
      masonry: 'Columns of images at their own proportions.',
      filmstrip: 'One row that scrolls sideways.',
      'contact-sheet': 'A dense grid of square crops.',
      pinboard: 'Loosely scattered prints you can drag.',
    };
    let view: View = 'masonry';
    const viewSetting = new Setting(form).setName('View').setDesc(viewDescs[view])
      .addDropdown(dropdown => {
        for (const name of VIEWS) dropdown.addOption(name, viewNames[name]);
        dropdown.setValue(view).onChange(value => { view = value as View; viewSetting.setDesc(viewDescs[view]); });
      });

    let countInput!: HTMLInputElement;
    new Setting(form).setName('Count')
      .setDesc('Leave blank to show 24 at a time with Load more. Enter a number to show that many random images with Shuffle.')
      .addText(text => {
        countInput = text.inputEl;
        text.setPlaceholder('1–100');
        Object.assign(countInput, { type: 'number', min: '1', max: '100', step: '1', inputMode: 'numeric' });
      });

    let wide = false;
    new Setting(form).setName('Width').setDesc('Wide extends past the readable line width.')
      .addDropdown(dropdown => dropdown
        .addOption('normal', 'Normal')
        .addOption('wide', 'Wide')
        .setValue('normal')
        .onChange(value => { wide = value === 'wide'; }));

    const status = form.createDiv({ cls: 'arena-status', attr: { role: 'alert' } });
    const buttons = form.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Cancel', attr: { type: 'button' } }).addEventListener('click', () => this.close());
    buttons.createEl('button', { text: 'Insert', cls: 'mod-cta', attr: { type: 'submit' } });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      let field = input;
      try {
        parseChannel(input.value);
        field = countInput;
        const count = countInput.value.trim() ? parseCount(countInput.value) : undefined;
        // Write a width line only when the choice differs from the setting, so the
        // embed renders as chosen without pinning blocks that match the default.
        const width = wide === this.wideByDefault ? undefined : wide ? 'wide' : 'normal';
        const block = embedMarkdown(input.value, count, view, width);
        const from = this.editor.getCursor('from');
        const to = this.editor.getCursor('to');
        const before = from.ch > 0 ? '\n\n' : '';
        const after = to.ch < this.editor.getLine(to.line).length ? '\n\n' : '\n';
        this.editor.replaceSelection(before + block + after);
        this.close();
      } catch (error) {
        status.setText(error instanceof Error ? error.message : 'Enter a valid channel URL.');
        field.focus();
      }
    });
    (selected ? countInput : input).focus();
  }

  onClose(): void { this.contentEl.empty(); }
}

class ArenaSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: ArenaPlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    let draft = this.plugin.settings.token;
    new Setting(this.containerEl)
      .setName('Personal access token')
      .setDesc('Use a read-scope token for private channels. Leave blank for public channels. Saved in this plugin’s settings and synced with your vault configuration.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.setValue(draft).onChange(value => { draft = value; });
      })
      .addButton(button => button.setButtonText('Save').setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.saveToken(draft);
          status.setText('Token saved. Reopen the note to reload its embeds.');
        } catch { status.setText('Could not save settings. Try again.'); }
        finally { button.setDisabled(false); }
      }));
    const status = this.containerEl.createDiv({ cls: 'arena-status', attr: { role: 'status' } });
    this.containerEl.createEl('a', { text: 'Create a token on Are.na', href: 'https://www.are.na/settings/oauth' });
    new Setting(this.containerEl)
      .setName('Wide embeds')
      .setDesc('Let embeds extend past the readable line width, so they use more columns and take less height. A block’s width: wide or width: normal line overrides this.')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.wide).onChange(value => { void this.plugin.saveWide(value); }));
    new Setting(this.containerEl)
      .setName('Clicking an image')
      .setDesc('Cmd-click (Ctrl-click on Windows) always opens Are.na.')
      .addDropdown(dropdown => dropdown
        .addOption('preview', 'Opens a preview')
        .addOption('arena', 'Opens Are.na')
        .setValue(this.plugin.settings.click)
        .onChange(value => {
          this.plugin.settings.click = value === 'arena' ? 'arena' : 'preview';
          void this.plugin.saveData(this.plugin.settings);
        }));
  }
}
