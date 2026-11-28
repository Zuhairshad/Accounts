"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { rankSearch } from "@/lib/smart-search";

export type SearchOption = { key: string; label: string; group: string; hint?: string };

const LIMIT = 80;

/**
 * One box that is both the search field and the picker: it shows the chosen option, and typing opens a ranked list
 * (smart-search.ts) under it. Arrow keys move, Enter or Tab picks, Escape keeps the previous choice. The list is
 * positioned fixed so scrolling table containers do not clip it.
 */
export function SearchSelect({ value, options, onChange, onCommit, label, placeholder, emptyText = "No match", invalidLabel }: {
  value: string; options: SearchOption[]; onChange: (key: string) => void; onCommit?: (input: HTMLInputElement) => void;
  label: string; placeholder?: string; emptyText?: string;
  /** Shown when the current value is not among the options (for example an inactive account on an old voucher). */
  invalidLabel?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);
  const chosen = options.find((option) => option.key === value);
  const shown = chosen?.label ?? invalidLabel ?? "";
  const typed = query ?? "";
  const ranked = useMemo(() => rankSearch(typed, options, (option) => option.label), [typed, options]);
  const visible = ranked.slice(0, LIMIT);
  const grouped = !typed.trim();

  const place = () => {
    const rect = input.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 280 > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
    setBox({ left: rect.left, top: above ? rect.top - 4 : rect.bottom + 4, width: Math.max(rect.width, 280), above });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);

  const close = () => { setOpen(false); setQuery(null); setActive(0); };
  const pick = (option: SearchOption | undefined, commit: boolean) => {
    if (option) onChange(option.key);
    close();
    if (option && commit && input.current) onCommit?.(input.current);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((index) => Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open) pick(visible[active], true);
      else setOpen(true);
    } else if (event.key === "Tab" && open && query !== null && visible.length) {
      pick(visible[active], false);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };

  const listId = `${id}-list`;
  let lastGroup = "";
  return <div className="search-select">
    <input ref={input} type="text" role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={open && visible[active] ? `${id}-${active}` : undefined} autoComplete="off" spellCheck={false}
      className={`search-select-input${chosen || invalidLabel ? " has-value" : ""}`} placeholder={placeholder}
      value={query ?? shown} title={shown || undefined}
      onFocus={(event) => { event.currentTarget.select(); setOpen(true); }}
      onClick={() => setOpen(true)}
      onBlur={close}
      onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onKeyDown={keyDown} />
    {open && box && <ul ref={list} id={listId} role="listbox" aria-label={label} className="search-select-list"
      style={{ left: box.left, width: box.width, ...(box.above ? { bottom: window.innerHeight - box.top } : { top: box.top }) }}
      onMouseDown={(event) => event.preventDefault()}>
      {visible.length ? visible.map((option, index) => {
        const heading = grouped && option.group !== lastGroup ? option.group : null;
        lastGroup = option.group;
        return [
          heading && <li key={`group-${heading}`} role="presentation" className="search-select-group">{heading}</li>,
          <li key={option.key} id={`${id}-${index}`} data-index={index} role="option" aria-selected={index === active}
            className={`search-select-option${option.key === value ? " is-chosen" : ""}`}
            onMouseEnter={() => setActive(index)} onClick={() => pick(option, true)}>
            <span>{option.label}</span>{!grouped && <small>{option.hint ?? option.group}</small>}
          </li>,
        ];
      }) : <li className="search-select-empty" role="presentation">{emptyText}</li>}
      {ranked.length > LIMIT && <li className="search-select-more" role="presentation">Showing {LIMIT} of {ranked.length}. Type more to narrow.</li>}
    </ul>}
  </div>;
}
