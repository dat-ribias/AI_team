document.getElementById('remote-form').onsubmit = async e => {
  e.preventDefault();
  const res = await fetch('/api/remote-login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Team-Request': '1' }, body: JSON.stringify({ key: document.getElementById('remote-key').value.trim() }) });
  if (res.ok) location.reload(); else document.getElementById('remote-error').textContent = (await res.json().catch(() => ({}))).error || 'Lỗi';
};
