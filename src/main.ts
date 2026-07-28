import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './assets/main.css'

// Opt back into the OS cursor set — see the .system-cursors block in main.css.
if (localStorage.getItem('olopdf:system-cursors') === '1') {
  document.body.classList.add('system-cursors')
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
