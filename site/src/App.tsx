import Nav from './components/Nav'
import Hero from './components/Hero'
import Ticker from './components/Ticker'
import Pipeline from './components/Pipeline'
import Privacy from './components/Privacy'
import MultiModel from './components/MultiModel'
import Channels from './components/Channels'
import Features from './components/Features'
import Roadmap from './components/Roadmap'
import Integrations from './components/Integrations'
import Philosophy from './components/Philosophy'
import WhyArgos from './components/WhyArgos'
import FAQ from './components/FAQ'
import Setup from './components/Setup'
import Footer from './components/Footer'

function App() {
  return (
    <div className="relative z-10" style={{ background: '#ffffff' }}>
      <Nav />
      <Hero />
      <Ticker />
      <Pipeline />
      <Privacy />
      <MultiModel />
      <Channels />
      <Features />
      <Roadmap />
      <Integrations />
      <Philosophy />
      <WhyArgos />
      <FAQ />
      <Setup />
      <Footer />
    </div>
  )
}

export default App
