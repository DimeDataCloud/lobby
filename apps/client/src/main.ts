import { createApp } from 'vue'
import Root from './Root.vue'

// The deployment can rename itself without a code change. index.html carries the
// default so the tab is never blank before this runs.
const name = import.meta.env.VITE_PRODUCT_NAME
if (name) document.title = name

createApp(Root).mount('#app')
