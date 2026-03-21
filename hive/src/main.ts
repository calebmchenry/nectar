import { HiveApp } from './App';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element.');
}

const app = new HiveApp(root);
void app.initialize();
