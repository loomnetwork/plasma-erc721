// NOTE: The order of the imports is important since that's the order the demos will run in,
//       each demo assumes a specific starting state left by the preceeding demos (at the moment
//       the leaky state consists of ERC721 token IDs).
// TODO: Redeploy the Solidity contracts before each demo so the demos don't share any state.
import './demo'
import './challenge-after-demo'
import './challenge-between-demo'
