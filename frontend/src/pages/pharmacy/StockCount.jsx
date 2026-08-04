import { StockCountPage } from '../../components/StockCountPage'

// Pharmacy Stock Count. The page is section-agnostic (it reads commoditySection
// from the store), so both sections share one implementation.
export function StockCount() { return <StockCountPage /> }
