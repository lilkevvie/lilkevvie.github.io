// Shared form helper: show a message on one field and keep the dialog open.

export function fieldError(form, name, msg) {
  const el = form.elements[name];
  el.setCustomValidity(msg);
  el.reportValidity();
  el.addEventListener('input', () => el.setCustomValidity(''), { once: true });
  return false;
}
