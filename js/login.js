// login.js - wiring for index.html

if (currentUser()) location.replace('dashboard.html');
ensureDemoUser();

const tabs = document.querySelectorAll('.auth-tabs button');
tabs.forEach(b => b.onclick = () => {
  tabs.forEach(x => x.classList.toggle('active', x === b));
  $('loginForm').hidden = b.dataset.tab !== 'login';
  $('registerForm').hidden = b.dataset.tab !== 'register';
  $('loginErr').textContent = $('regErr').textContent = '';
});

$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await login($('lUser').value, $('lPass').value, $('lRemember').checked);
    location.href = 'dashboard.html';
  } catch (err) {
    $('loginErr').textContent = err.message;
    btn.disabled = false;
  }
};

$('registerForm').onsubmit = async e => {
  e.preventDefault();
  try {
    await registerUser($('rUser').value, $('rName').value, $('rPass').value, $('rPass2').value);
    await login($('rUser').value, $('rPass').value, false);
    location.href = 'dashboard.html';
  } catch (err) {
    $('regErr').textContent = err.message;
  }
};

$('fillDemo').onclick = () => {
  $('lUser').value = 'demo';
  $('lPass').value = 'demo123';
};
