import React from 'react'
import { motion } from 'framer-motion'

interface CardProps {
  children: React.ReactNode
  className?: string
  variant?: 'default' | 'green' | 'red'
  hover?: boolean
}

export function Card({ children, className = '', variant = 'default', hover = false }: CardProps) {
  const variantClass = variant === 'green' ? 'hud-card-green' : variant === 'red' ? 'hud-card-red' : ''

  if (hover) {
    return (
      <motion.div
        className={`hud-card ${variantClass} rounded-sm p-5 ${className}`}
        whileHover={{ borderColor: 'rgba(0,212,255,0.4)', y: -2 }}
        transition={{ duration: 0.2 }}
      >
        {children}
      </motion.div>
    )
  }

  return (
    <div className={`hud-card ${variantClass} rounded-sm p-5 ${className}`}>
      {children}
    </div>
  )
}
