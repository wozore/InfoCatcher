document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('[data-nav-menu]').forEach(group=>{const button=group.querySelector('button'),menu=group.querySelector('.nav-menu');button?.addEventListener('click',()=>{const open=menu.classList.toggle('open');button.setAttribute('aria-expanded',String(open))})});
  document.addEventListener('click',e=>document.querySelectorAll('.nav-menu.open').forEach(menu=>{if(!menu.parentElement.contains(e.target)){menu.classList.remove('open');menu.previousElementSibling?.setAttribute('aria-expanded','false')}}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.nav-menu.open').forEach(menu=>{menu.classList.remove('open');menu.previousElementSibling?.setAttribute('aria-expanded','false')})});
  document.querySelectorAll('[data-demo-stage]').forEach(form=>form.addEventListener('submit',e=>{e.preventDefault();const status=form.querySelector('.status-line');if(status){status.textContent='已展示静态示例阶段；不会执行真实检索。';status.className='status-line state success'}}));
  document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',()=>{const text=document.querySelector(button.dataset.copy)?.textContent||'';navigator.clipboard?.writeText(text);button.textContent='已复制示例';setTimeout(()=>button.textContent='复制',1200)}));
});
