# Localization

Application source strings, comments, server diagnostics, and terminal output
are English. Human-facing web text is translated using UTF-8 JSON dictionaries:

- `web/locales/en.json`: English source messages and fallback translations.
- `web/locales/ru.json`: Russian translations with the same keys.
- `web/locales/languages.json`: supported language codes, native display names,
  and Intl locale identifiers.

The browser preference determines the initial language. A choice in Settings
overrides that preference and is saved in this browser's localStorage.
Switching languages updates the current view without reloading the page or
replacing the audio source. Other browsers can use different languages.

## Adding a language

1. Copy `en.json` to a file such as `de.json` and translate its values.
2. Add `{"code":"de", "name":"Deutsch", "locale":"de-DE"}` to `languages.json`.
3. Keep the message keys and named parameters unchanged. A missing translation
   falls back to English. No server route or application logic changes are needed.

Use simple language codes containing letters, digits, underscores, or hyphens.
Dictionaries contain plain text, never HTML or executable JavaScript.

## Adding interface text

Add the English message to both dictionaries and call:

```javascript
tr('Selected: {count}', {count: selected.size})
```

Keep complete sentences together and use named parameters so translators can
change word order. Parameter values are literal text; they are not translated
recursively. Do not translate track tags, file paths, playlist names, device
names, custom server names, or other user data.

For static markup, use `data-i18n` on a text-only element:

```html
<button data-i18n="Save">Save</button>
<input placeholder="Search" data-i18n-placeholder="Search">
```

For mixed content, wrap only its text in a neutral inline element:

```html
<button><span aria-hidden="true">＋</span> <i18n-text data-i18n="Add">Add</i18n-text></button>
```

Supported translated attributes are `title`, `placeholder`, and `aria-label`.
Use `textContent` for text and `escapeHTML(tr(...))` when interpolating a
translation into generated HTML. Static localization never replaces innerHTML.
Dates and display sorting use `MusicI18n.locale`; catalog identity normalization
must stay independent of the interface language.

`i18n.js` loads dictionaries before `bootstrap.js` evaluates the application
scripts listed as `data-app-src` in `index.html`. Preserve their order when
adding a script. Register new script assets in `http_api.py` as well.

The API retains English error strings. `MusicI18n.message()` translates known
errors and prefixes while preserving appended paths. Operation descriptions
also expose structured `labelMessage` and `detailMessages` objects containing
keys and parameters; `MusicI18n.renderMessage()` translates these without
translating the user data they contain. The existing plain fields remain
available for API clients. External tool and operating-system diagnostics, and
older persisted free-form messages, are displayed as supplied.

## Checks

```bash
python -m unittest discover -s tests -q
node --test tests/*.test.cjs
```

Tests cover language persistence, fallback, parameters, concurrent language
loads, dictionary parity, HTTP delivery, and language switching during playback.
