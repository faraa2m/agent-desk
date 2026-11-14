/**
 * Filters `{ name, description }` options by a free-text query, case ignored.
 * An empty query keeps every option in its given order. Otherwise options whose
 * name starts with the query come first, then names containing it, then those
 * matching only in the description.
 */
export function filterOptions(options, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const rank = (o) => {
    const name = o.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if ((o.description ?? '').toLowerCase().includes(q)) return 2;
    return -1;
  };
  return options
    .map((o, i) => ({ o, i, r: rank(o) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o);
}

/**
 * Turns a text input into a combobox: a dropdown of `getOptions()` that filters
 * as you type, while any typed text stays a valid value. Choosing an option
 * fills the input and fires its `input` event.
 */
export function attachCombobox({ input, toggle, listbox, getOptions }) {
  let shown = [];
  let active = -1;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listbox.id);
  listbox.setAttribute('role', 'listbox');

  const isOpen = () => !listbox.hidden;

  function setActive(i) {
    active = i;
    [...listbox.querySelectorAll('[role="option"]')].forEach((li, idx) => {
      li.setAttribute('aria-selected', String(idx === i));
      if (idx === i) li.scrollIntoView({ block: 'nearest' });
    });
    if (i >= 0) input.setAttribute('aria-activedescendant', `${listbox.id}-${i}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function render(showAll) {
    const options = getOptions();
    const value = input.value.trim();
    const exact = options.some((o) => o.name === value);
    shown = showAll || exact ? [...options] : filterOptions(options, value);
    const items = shown.map((o, i) => {
      const li = document.createElement('li');
      li.id = `${listbox.id}-${i}`;
      li.setAttribute('role', 'option');
      li.dataset.index = String(i);
      const name = document.createElement('span');
      name.className = 'combo-name';
      name.textContent = o.name;
      li.append(name);
      if (o.description) {
        const desc = document.createElement('span');
        desc.className = 'combo-desc';
        desc.textContent = o.description;
        li.append(desc);
      }
      return li;
    });
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'combo-empty';
      li.textContent = options.length
        ? value ? `No agent matches; "${value}" will be used as typed.` : 'No agents.'
        : 'No agents found in ~/.claude/agents.';
      items.push(li);
    }
    listbox.replaceChildren(...items);
    // Enter picks the highlighted option, so only an exact or prefix match is
    // highlighted up front; other typed text stays as typed unless the user
    // moves to an option.
    const current = shown.findIndex((o) => o.name === value);
    const prefix = value && shown[0]?.name.toLowerCase().startsWith(value.toLowerCase()) ? 0 : -1;
    setActive(current >= 0 ? current : prefix);
  }

  function open(showAll = false) {
    render(showAll);
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  }

  function choose(i) {
    const option = shown[i];
    if (!option) return;
    input.value = option.name;
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  input.addEventListener('focus', () => open());
  input.addEventListener('click', () => { if (!isOpen()) open(); });
  input.addEventListener('blur', close);
  input.addEventListener('input', (e) => {
    if (e.isTrusted) open();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) return open();
      if (!shown.length) return;
      const n = shown.length;
      if (active < 0) setActive(e.key === 'ArrowDown' ? 0 : n - 1);
      else setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter' && isOpen() && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  // mousedown keeps focus in the input, so blur does not close the list first.
  listbox.addEventListener('mousedown', (e) => e.preventDefault());
  listbox.addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) choose(Number(li.dataset.index));
  });
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', () => {
    if (isOpen()) return close();
    input.focus();
    open(true);
  });

  return { open, close, refresh: () => { if (isOpen()) render(false); } };
}
