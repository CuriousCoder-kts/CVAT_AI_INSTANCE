"""
Minimal, zero-dependency template engine for the {{variable}} syntax.

Why not Jinja2 / Mustache?
  * Security: no arbitrary expressions, no SSTI (server-side template injection)
    attack surface — CVAT untrusted users write prompts.
  * Zero dependency: avoid adding Jinja2/sandbox packages to the Django image.
  * Sufficient for our use-case: we only need flat key-value substitution;
    any loop/conditional logic belongs in the natural-language prompt text
    written by the user, not in a template DSL.

Design choices (aligned with Dify / Microsoft Prompty variable semantics):
  * Variable names: only `[A-Za-z_][A-Za-z0-9_]*` (identifier-like).
    This keeps the scanner safe and consistent with Dify's input variable rules.
  * Literal double-braces `{{{{` -> `{{` and `}}}}` -> `}}` for escaping
    (LangFlow / LangChain use the same escape convention so users are familiar).
  * Unmatched / unknown variables: left as-is (not silently removed) so
    the user can immediately spot typos in variable names.

Benchmark vs main.py existing string concatenation:
  * Simple regex `re.sub` scan — constant overhead for prompts < 100KB.
  * Called once per VLM invocation — totally negligible vs 55s API timeout.
"""

from __future__ import annotations

import re
from typing import Mapping


_VAR_PATTERN = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def _escape_literals(text: str) -> tuple[str, list[str]]:
    """Replace escaped {{{{ / }}}} with placeholders so VAR_PATTERN won't match them."""
    placeholders: list[str] = []
    def _stash(match: re.Match) -> str:
        placeholders.append(match.group(0))
        return f"\x00ESCAPED_BRACE_{len(placeholders)-1}\x00"
    # Match exactly 4 braces (Dify / Prompty convention)
    text = re.sub(r"\{\{\{\{", _stash, text)
    text = re.sub(r"\}\}\}\}", _stash, text)
    return text, placeholders


def _restore_literals(text: str, placeholders: list[str]) -> str:
    for i, raw in enumerate(placeholders):
        token = f"\x00ESCAPED_BRACE_{i}\x00"
        # {{{{ -> literal {{   and   }}}} -> literal }}
        if raw.startswith("{"):
            text = text.replace(token, "{{")
        elif raw.startswith("}"):
            text = text.replace(token, "}}")
    return text


def render_template(template: str, variables: Mapping[str, object]) -> str:
    """Replace every {{variable}} in `template` with str(variables[variable]).

    Args:
        template: Text with optional {{var}} placeholders.  Empty/None -> "".
        variables: Variable name -> value mapping.  Values are `str(...)`'d.

    Returns:
        Rendered string.  Undefined variables are LEFT AS-IS (with braces) so
        the caller / frontend preview can highlight typos.
    """
    if not template:
        return ""
    template = str(template)

    escaped, stashes = _escape_literals(template)

    def _replace(match: re.Match) -> str:
        name = match.group(1)
        if name in variables:
            return str(variables[name])
        # Unresolved: keep literal placeholder text so typos are obvious.
        return match.group(0)

    rendered = _VAR_PATTERN.sub(_replace, escaped)
    return _restore_literals(rendered, stashes)


def extract_variable_names(template: str) -> list[str]:
    """Return the list of unique variable names referenced in `template`.

    Frontend uses this to auto-suggest variables the user forgot to declare
    in their prompt_variables array.  Same heuristic as LangFlow's
    "prompt template scanner" panel.
    """
    if not template:
        return []
    stripped, _ = _escape_literals(str(template))
    seen: list[str] = []
    for m in _VAR_PATTERN.finditer(stripped):
        name = m.group(1)
        if name not in seen:
            seen.append(name)
    return seen
