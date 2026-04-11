import { buildCartContext, evaluateCouponForCart } from '../Controller/couponController.js';

const TOLERANCE = 0.05;

/**
 * Validates cart line totals, shipping rule, and coupon server-side.
 * Rejects client-invented discounts when no coupon_code is sent.
 */
export async function validateCheckoutTotals({
  items,
  userId,
  coupon_code,
  clientTotalAmount,
  clientDiscountAmount,
  shipping_charges,
  blessing_charge,
}) {
  const { subtotal } = await buildCartContext(items);
  if (Math.abs(subtotal - Number(clientTotalAmount)) > TOLERANCE) {
    return {
      ok: false,
      status: 400,
      message: 'Cart total does not match current prices. Please refresh and try again.',
    };
  }

  const serverShipping = subtotal > 1000 ? 0 : 50;
  if (Math.abs(serverShipping - Number(shipping_charges || 0)) > TOLERANCE) {
    return {
      ok: false,
      status: 400,
      message: 'Shipping amount is invalid for this cart.',
    };
  }

  let effectiveDiscount = 0;
  let appliedCoupon = null;
  if (coupon_code) {
    const couponEval = await evaluateCouponForCart({
      code: coupon_code,
      items,
      userId,
    });
    if (!couponEval.ok) {
      return { ok: false, status: couponEval.status || 400, message: couponEval.message };
    }
    appliedCoupon = couponEval.coupon;
    effectiveDiscount = Number(couponEval.discount_amount || 0);
  } else if (Number(clientDiscountAmount) > TOLERANCE) {
    return {
      ok: false,
      status: 400,
      message: 'Discount is not valid for this order.',
    };
  }

  const bless = Number(blessing_charge) || 0;
  const computedPreWallet = Math.max(
    0,
    subtotal - effectiveDiscount + serverShipping + bless,
  );

  return {
    ok: true,
    serverSubtotal: subtotal,
    effectiveDiscount,
    serverShipping,
    blessingCharge: bless,
    computedPreWallet,
    appliedCoupon,
  };
}

export function amountsMatch(a, b) {
  return Math.abs(Number(a) - Number(b)) <= TOLERANCE;
}
