import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'urql';
import { App } from './App';
import { ToastProvider } from './components/Toasts';
import { createClient, createLogClient } from './graphql/client';
import { LogClientContext } from './hooks/useLogStream';
import './styles.css';

const client = createClient();
const logClient = createLogClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider value={client}>
      <LogClientContext.Provider value={logClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </LogClientContext.Provider>
    </Provider>
  </StrictMode>,
);
